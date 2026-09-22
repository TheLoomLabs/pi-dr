import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultSearxngUrl, loadConfig } from "./config.ts";
import { findEngine, provisionSearxng, stopContainer, systemRunner } from "./provision.ts";
import { readStatus, toggleLabel } from "./status.ts";
import { refreshIndicator, startIndicator, stopIndicator } from "./indicator.ts";
import { HomeCard } from "./ui/home-card.ts";
import { probeSearxng, waitForSearxng } from "./searxng.ts";
import { resolveSettings, values, writeSettings, type Tunables } from "./settings.ts";
import { SettingsCard } from "./ui/settings-card.ts";
import { SetupCard, type SetupChoice } from "./ui/setup-card.ts";
import { type Caller, type EngineOptions, executeRun, planRun } from "./engine.ts";
import { canApprove, listRuns, newRunId, runsDir, saveRun, setPlan } from "./store.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { cardGeometry, cardRows } from "./ui/frame.ts";
import type { Run } from "./types.ts";
import { PlanEditor } from "./ui/plan-editor.ts";
import { ResearchMonitor } from "./ui/monitor.ts";

const STATUS_KEY = "deep-research";

function newRun(question: string, model: string): Run {
	const config = loadConfig();
	const now = Date.now();
	return {
		id: newRunId(),
		question,
		status: "planning",
		plan: null,
		planRevision: 0,
		planHash: null,
		steps: [],
		sources: [],
		researchState: null,
		audit: null,
		report: null,
		error: null,
		budgets: config.budgets,
		websitePolicy: config.websitePolicy,
		model,
		// Stamped once, so a run spanning midnight keeps the date it was planned against.
		currentDate: new Date(now).toISOString().slice(0, 10),
		createdAt: now,
		updatedAt: now,
	};
}

/** One provider-neutral model call. The research loop deliberately does not run inside the
 *  chat turn: planning, deciding, auditing and writing are separate calls with their own
 *  system prompts, and none of their scratch work belongs in the conversation. */
function makeCaller(ctx: ExtensionContext): Caller {
	return async ({ system, user, maxTokens, json, signal }) => {
		const model = ctx.model;
		if (!model) throw new Error("No model is active");
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }],
			},
			{
				signal,
				// Advisory: a provider that does not accept it uses its default.
				...(maxTokens !== undefined ? { maxTokens } : {}),
				// A JSON call wants the object, not a deliberation about it, and a
				// thinking model that spends its whole budget deliberating returns
				// an empty reply. This is the switch Qwen-style templates read on
				// OpenAI-compatible servers; adapters that do not know it drop it,
				// and the parsers read the thinking block either way.
				...(json
					? { samplingParams: { chat_template_kwargs: { enable_thinking: false } } }
					: {}),
			},
		);
		if (response.stopReason === "aborted") throw new Error("aborted");

		// Text and thinking are collected separately. A thinking model routinely
		// reasons its way to the answer and stops, leaving the content empty and
		// the JSON in the thinking block; the parsers read both.
		const parts: readonly { type: string }[] = response.content ?? [];
		const text = parts
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const reasoning = parts
			.filter((part): part is { type: "thinking"; thinking: string } => part.type === "thinking")
			.map((part) => part.thinking)
			.join("\n");

		return {
			text,
			reasoning,
			stopReason: String(response.stopReason ?? "stop"),
			...(response.usage ? { usage: response.usage } : {}),
		};
	};
}

function recordUsage(run: Run, total: Usage): void {
	run.usage = {
		input: total.input,
		output: total.output,
		totalTokens: total.totalTokens,
		costTotal: total.cost?.total ?? 0,
	};
}

/** `87k tokens`, or nothing when the provider reported none. */
function usageLabel(run: Run): string {
	const tokens = run.usage?.totalTokens ?? 0;
	if (!tokens) return "";
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`;
}

async function writeReportFile(cwd: string, run: Run): Promise<string> {
	const dir = runsDir(cwd);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${run.id}.md`);
	await writeFile(path, `# ${run.plan?.title ?? run.question}\n\n${run.report ?? ""}\n`, "utf8");
	return path;
}

/** Show the plan and let the user rewrite it. Returns the approved plan, or null on cancel.
 *  Approval names the revision and hash that were on screen: if anything wrote the plan in
 *  between, the approval is refused rather than silently applied to different text. */
async function approvePlan(ctx: ExtensionContext, run: Run): Promise<boolean> {
	const revision = run.planRevision;
	const hash = run.planHash!;

	const result = await ctx.ui.custom<{ plan: Run["plan"]; approved: boolean } | null>(
		(tui, theme, _keybindings, done) => {
			const editor = new PlanEditor(run.plan!, theme, run.budgets.maxSteps);
			editor.onDone = done;
			return {
				render: (width: number) => editor.render(width),
				invalidate: () => editor.invalidate(),
				handleInput: (data: string) => {
					editor.handleInput(data);
					tui.requestRender();
				},
			};
		},
		// Centred and capped: a share of the terminal degenerates into a
		// 190-column plan on a wide monitor. See ui/frame.ts.
		{ overlay: true, overlayOptions: cardGeometry() },
	);

	if (!result || !result.approved || !result.plan) return false;
	if (!canApprove(run, revision, hash)) {
		ctx.ui.notify("The plan changed while you were reviewing it. Re-run /research.", "warning");
		return false;
	}
	setPlan(run, result.plan);
	return true;
}

async function runInteractively(ctx: ExtensionContext, run: Run, usage: { total: Usage }): Promise<Run> {
	const config = loadConfig();
	const call = makeCaller(ctx);

	const report = await ctx.ui.custom<string | Error | null>((tui, theme, _keybindings, done) => {
		const monitor = new ResearchMonitor(theme, () => tui.requestRender(), run.plan!.title);
		monitor.onAbort = () => {
			monitor.dispose();
			done(null);
		};

		const options: EngineOptions = {
			config,
			call,
			usage,
			contextWindow: ctx.model?.contextWindow,
			signal: monitor.signal,
			save: (updated) => saveRun(ctx.cwd, updated),
			onProgress: (event) => {
				switch (event.type) {
					case "phase":
						monitor.setPhase(event.detail ? `${event.phase} (${event.detail})` : event.phase);
						break;
					case "step":
						monitor.step(event.action, event.input);
						break;
					case "sources":
						monitor.sources(event.count, event.total);
						break;
					case "note":
						monitor.note(event.text);
						break;
					default:
						break;
				}
			},
		};

		executeRun(run, options)
			.then((text) => {
				monitor.dispose();
				done(text);
			})
			.catch((error: Error) => {
				monitor.dispose();
				done(error);
			});

		return {
			render: (width: number) => monitor.render(width),
			invalidate: () => monitor.invalidate(),
			handleInput: (data: string) => {
				monitor.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: cardGeometry() });

	if (report === null) {
		run.status = "cancelled";
		await saveRun(ctx.cwd, run);
		ctx.ui.notify(`Research stopped. ${run.sources.length} sources kept in run ${run.id}.`, "info");
		return run;
	}
	if (report instanceof Error) {
		run.status = "failed";
		run.error = report.message;
		await saveRun(ctx.cwd, run);
		throw report;
	}
	return run;
}

/** The settings screen. Changes are applied and persisted as they are made. */
async function openSettings(ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<null>(
		(tui, theme, _keybindings, done) => {
			const card = new SettingsCard(theme, resolveSettings(), values());
			card.onChange = (update) => writeSettings(update as Partial<Tunables>);
			card.onClose = () => done(null);
			return {
				render: (width: number) => card.render(width, cardRows()),
				invalidate: () => card.invalidate(),
				handleInput: (data: string) => {
					card.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: cardGeometry() },
	);
}

/**
 * The hub `/research` opens: a question to type, what the search backend is
 * doing, and what has been researched here before.
 *
 * Returns the question to research, or null if the card was closed. Starting
 * and stopping SearXNG happens inside it, because a card that reports a state
 * and cannot change it is a card that sends you to a terminal.
 */
/** Sentinel: the hub closed because the settings screen was asked for, and it
 *  should reopen once that screen is done. */
const SETTINGS = "\u0000settings";

async function openHomeOnce(ctx: ExtensionContext, initial: string): Promise<string | null> {
	const runs = await listRuns(ctx.cwd);

	return ctx.ui.custom<string | null>(
		(tui, theme, _keybindings, done) => {
			const card = new HomeCard(theme, runs, initial);
			const signal = new AbortController().signal;

			const refresh = async (): Promise<void> => {
				card.setStatus(await readStatus(signal));
				tui.requestRender();
			};

			const narrate = (line: string): void => {
				card.setBusy(line);
				tui.requestRender();
			};

			const toggle = async (): Promise<void> => {
				const status = await readStatus(signal);
				const next = toggleLabel(status);
				if (next.action === "none") {
					card.setMessage(
						next.label === "external instance"
							? "That URL is not a container this extension started, so it is not ours to stop."
							: "No Docker or Podman on this machine.",
					);
					tui.requestRender();
					return;
				}

				if (next.action === "stop") {
					narrate("stopping the container");
					const stopped = await stopContainer(systemRunner, status.engine as string, signal);
					if (!stopped.ok) card.setMessage(stopped.detail);
					await refresh();
					void refreshIndicator(ctx);
					return;
				}

				const started = await provisionSearxng({ signal, onStep: narrate });
				if (!started.ok) {
					card.setMessage(started.detail);
					tui.requestRender();
					return;
				}
				narrate("waiting for it to answer a search");
				await waitForSearxng({ ...loadConfig(), searxngUrl: started.url }, signal);
				writeSettings({ searxngUrl: started.url });
				await refresh();
				void refreshIndicator(ctx);
			};

			card.onClose = () => done(null);
			card.onAction = (action) => {
				if (action.kind === "research") return done(action.question);
				if (action.kind === "settings") return done(SETTINGS + action.question);
				void toggle().catch((error: unknown) => {
					card.setMessage(error instanceof Error ? error.message : String(error));
					tui.requestRender();
				});
			};

			// Not awaited: the card opens immediately and fills its status line a
			// moment later, rather than the command hanging on a probe.
			void refresh();

			return {
				render: (width: number) => card.render(width, cardRows()),
				invalidate: () => card.invalidate(),
				handleInput: (data: string) => {
					card.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: cardGeometry() },
	);
}

/** The hub, reopened after any screen it launches, so settings is a detour
 *  rather than an exit. */
async function openHome(ctx: ExtensionContext, initial: string): Promise<string | null> {
	let seed = initial;
	for (;;) {
		const answer = await openHomeOnce(ctx, seed);
		if (answer === null || !answer.startsWith(SETTINGS)) return answer;
		await openSettings(ctx);
		seed = answer.slice(SETTINGS.length);
	}
}

/**
 * Make sure there is something to search before anything is planned.
 *
 * Detection is automatic; setting anything up is not. Starting a container is a
 * change to the machine that outlives the session, so the card asks first — and
 * a run that cannot search is stopped here, where the message can say what to
 * do, rather than three model calls later with an empty report.
 */
async function ensureSearch(ctx: ExtensionContext, signal: AbortSignal): Promise<boolean> {
	// A probe is one request; provisioning is minutes. Only the probes get a
	// deadline, or a cold image pull would look like a hung instance.
	const quick = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const probe = await probeSearxng(loadConfig(), quick());
	if (probe.ok) return true;

	if (!ctx.hasUI || ctx.mode !== "tui") {
		// Nobody to ask. Say the whole fix in one line instead of half of it.
		ctx.ui.notify(
			`Deep research needs SearXNG with its JSON API enabled. ${probe.detail} ` +
				"Run /research in an interactive session to set one up, or set PI_DR_SEARXNG_URL.",
			"error",
		);
		return false;
	}

	const engine = await findEngine(systemRunner, signal);

	const outcome = await ctx.ui.custom<{ url: string; detail: string } | null>(
		(tui, theme, _keybindings, done) => {
			const card = new SetupCard({
				theme,
				url: loadConfig().searxngUrl || defaultSearxngUrl(),
				reason: probe.needsJson
					? "Add `json` to `search.formats` in its settings.yml and restart it, or let this start its own instance."
					: probe.detail,
				needsJson: probe.needsJson,
				dockerAvailable: engine !== undefined,
			});

			const narrate = (line: string): void => {
				card.setWorking(line);
				tui.requestRender();
			};

			const apply = async (choice: SetupChoice): Promise<void> => {
				if (choice.kind === "cancel") return done(null);

				if (choice.kind === "url") {
					narrate(`checking ${choice.url}`);
					const check = await probeSearxng({ ...loadConfig(), searxngUrl: choice.url }, quick());
					if (!check.ok) {
						card.fail(check.detail);
						tui.requestRender();
						return;
					}
					return done({ url: choice.url, detail: `Using ${choice.url}.` });
				}

				const result = await provisionSearxng({ signal, onStep: narrate });
				if (!result.ok) {
					card.fail(result.detail);
					tui.requestRender();
					return;
				}
				narrate("waiting for it to answer a search");
				const ready = await waitForSearxng({ ...loadConfig(), searxngUrl: result.url }, signal);
				if (!ready.ok) {
					card.fail(`Started, but it never answered: ${ready.detail}`);
					tui.requestRender();
					return;
				}
				done({ url: result.url, detail: result.detail });
			};

			card.onDone = (choice) => {
				if (!choice) return done(null);
				void apply(choice).catch((error: unknown) => {
					card.fail(error instanceof Error ? error.message : String(error));
					tui.requestRender();
				});
			};

			return {
				render: (width: number) => card.render(width),
				invalidate: () => card.invalidate(),
				handleInput: (data: string) => {
					card.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: cardGeometry() },
	);

	if (!outcome) {
		ctx.ui.notify("Deep research needs a SearXNG instance. Nothing was changed.", "info");
		return false;
	}

	const saved = writeSettings({ searxngUrl: outcome.url });
	ctx.ui.notify(
		saved.ok ? outcome.detail : `${outcome.detail} Could not save the URL: ${saved.error ?? "unknown error"}`,
		saved.ok ? "info" : "warning",
	);
	return true;
}

export default function (pi: ExtensionAPI) {
	// The transcript card for a finished report. A custom entry, so it is durable
	// and rendered but never part of the model's context — the pointer message
	// carries that, at a hundredth of the size.
	pi.registerEntryRenderer("deep-research-report", (entry, { expanded }, theme) => {
		const data = entry.data as {
			title?: string;
			question?: string;
			sources?: number;
			path?: string;
			report?: string;
		};
		const container = new Container();
		container.addChild(
			new Text(
				`${theme.fg("accent", "\u25c6")} ${theme.bold(data.title ?? "Deep research")} ` +
					theme.fg("dim", `\u00b7 ${data.sources ?? 0} sources`),
				1,
				0,
			),
		);
		if (expanded && data.report) {
			container.addChild(new Markdown(data.report, 1, 0, getMarkdownTheme()));
		} else {
			container.addChild(new Text(theme.fg("dim", data.path ?? ""), 1, 0));
		}
		return container;
	});

	// Background work starts here, never in the factory: an extension factory
	// also runs in invocations that never open a session.
	pi.on("session_start", async (_event, ctx) => {
		startIndicator(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopIndicator(ctx);
	});

	pi.registerCommand("research", {
		description: "Deep research: plan, review the plan, then research and write a cited report",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/research needs the interactive TUI. Use the deep_research tool instead.", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model is active.", "error");
				return;
			}

			// An argument is the shortcut; with none, the hub is the front door.
			const typed = (args ?? "").trim();
			const question = typed || (await openHome(ctx, "")) || "";
			if (!question.trim()) return;

			// Before the plan, not after: a run that cannot search should stop
			// where the message can still say what to do about it.
			if (!(await ensureSearch(ctx, new AbortController().signal))) return;

			const run = newRun(question.trim(), ctx.model.id);
			await saveRun(ctx.cwd, run);
			const usage = { total: emptyUsage() };

			try {
				ctx.ui.setStatus(STATUS_KEY, "planning research...");
				const planned = await ctx.ui.custom<Error | null>((tui, theme, _kb, done) => {
					const monitor = new ResearchMonitor(theme, () => tui.requestRender(), "Planning research");
					monitor.onAbort = () => {
						monitor.dispose();
						done(new Error("cancelled"));
					};
					planRun(run, {
						config: loadConfig(),
						call: makeCaller(ctx),
						usage,
						contextWindow: ctx.model?.contextWindow,
						signal: monitor.signal,
						save: (updated) => saveRun(ctx.cwd, updated),
						onProgress: (event) => {
							if (event.type === "phase") monitor.setPhase(event.phase);
						},
					})
						.then(() => {
							monitor.dispose();
							done(null);
						})
						.catch((error: Error) => {
							monitor.dispose();
							done(error);
						});
					return {
						render: (width: number) => monitor.render(width),
						invalidate: () => monitor.invalidate(),
						handleInput: (data: string) => {
							monitor.handleInput(data);
							tui.requestRender();
						},
					};
				}, { overlay: true, overlayOptions: cardGeometry() });

				if (planned) {
					if (planned.message !== "cancelled") throw planned;
					ctx.ui.notify("Planning cancelled.", "info");
					return;
				}

				if (!(await approvePlan(ctx, run))) {
					run.status = "cancelled";
					await saveRun(ctx.cwd, run);
					ctx.ui.notify("Research cancelled before it started.", "info");
					return;
				}

				await runInteractively(ctx, run, usage);
				if (run.status !== "completed") return;

				recordUsage(run, usage.total);
				const path = await writeReportFile(ctx.cwd, run);
				await saveRun(ctx.cwd, run);

				const spent = usageLabel(run);
				ctx.ui.notify(
					`Report written to ${path}${spent ? ` \u00b7 ${spent}` : ""}`,
					"info",
				);

				// The report goes in the transcript as an entry, which is durable and
				// rendered but deliberately NOT part of the model's context. Injecting
				// 14k characters as a queued message meant the next thing the user typed
				// — "hi" — arrived with a research report attached, and the model
				// answered the report instead of the greeting.
				pi.appendEntry("deep-research-report", {
					runId: run.id,
					question: run.question,
					title: run.plan?.title ?? run.question,
					sources: run.sources.length,
					path,
					report: run.report,
				});

				// What the model gets is a pointer, not the payload: short enough to be
				// harmless whenever it lands, and enough to read the file on request.
				pi.sendMessage(
					{
						customType: "deep-research",
						content:
							`[notice, no reply needed] Deep research finished for "${run.question}". ` +
							`The full cited report is saved at ${path} (${run.sources.length} sources). ` +
							"Read that file if the user asks about it.",
						display: false,
						details: { runId: run.id, sources: run.sources.length, path },
					},
					{ deliverAs: "nextTurn" },
				);
			} catch (error) {
				ctx.ui.notify(`Research failed: ${(error as Error).message}`, "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});

	pi.registerCommand("research-runs", {
		description: "List saved deep research runs in this project",
		handler: async (_args, ctx) => {
			const runs = await listRuns(ctx.cwd);
			if (runs.length === 0) {
				ctx.ui.notify("No research runs in this project yet.", "info");
				return;
			}
			ctx.ui.setWidget(
				STATUS_KEY,
				runs
					.slice(0, 10)
					.map(
						(run) =>
							`${run.id}  ${run.status.padEnd(17)} ${run.sources.length} sources  ${run.question.slice(0, 60)}`,
					),
			);
			ctx.ui.notify("Recent runs shown above the editor. Reports are in .pi/research/.", "info");
		},
	});

	pi.registerTool({
		name: "deep_research",
		label: "Deep Research",
		description:
			"Run a multi-step web research loop over a self-hosted SearXNG instance and return a " +
			"cited report. Use it for questions that need current, external, or corroborated " +
			"information rather than reasoning over the repository. In an interactive session the " +
			"user reviews and edits the research plan before it runs.",
		promptSnippet: "Research a question on the web and return a cited report",
		promptGuidelines: [
			"Use deep_research when a question needs current external evidence, not for questions answerable from the repository.",
			"Pass deep_research one self-contained question; it does not see the conversation.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "A self-contained research question. The loop never sees the conversation.",
				maxLength: 2000,
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.model) throw new Error("No model is active");
			const question = params.question.trim();
			if (!question) throw new Error("deep_research needs a question");

			if (!(await ensureSearch(ctx, signal ?? new AbortController().signal))) {
				throw new Error(
					"No usable SearXNG instance. Run /research once to set one up, or set PI_DR_SEARXNG_URL.",
				);
			}

			const run = newRun(question, ctx.model.id);
			await saveRun(ctx.cwd, run);

			// The tool signal is absent outside an active turn; a never-aborting one keeps the
			// engine's cancellation plumbing uniform.
			const runSignal = signal ?? new AbortController().signal;
			const config = loadConfig();
			const usage = { total: emptyUsage() };
			const base = {
				config,
				call: makeCaller(ctx),
				usage,
				contextWindow: ctx.model.contextWindow,
				save: (updated: Run) => saveRun(ctx.cwd, updated),
				onProgress: () => {},
			};

			await planRun(run, { ...base, signal: runSignal });

			// Interactive sessions get the same review gate the command has; headless ones
			// (print/json/rpc) run the plan the model drafted, because nobody is there to approve.
			if (ctx.hasUI && ctx.mode === "tui") {
				if (!(await approvePlan(ctx, run))) {
					run.status = "cancelled";
					await saveRun(ctx.cwd, run);
					return {
						content: [{ type: "text", text: "The user cancelled the research plan." }],
						details: { runId: run.id, cancelled: true },
					};
				}
				await runInteractively(ctx, run, usage);
			} else {
				await executeRun(run, { ...base, signal: runSignal });
			}

			if (run.status !== "completed" || !run.report) {
				return {
					content: [{ type: "text", text: `Research did not complete (${run.status}).` }],
					details: { runId: run.id, status: run.status },
				};
			}

			recordUsage(run, usage.total);
			const path = await writeReportFile(ctx.cwd, run);
			await saveRun(ctx.cwd, run);
			// A long report would crowd out the conversation, so the tail stays on disk.
			const capped =
				run.report.length > 30_000
					? `${run.report.slice(0, 30_000)}\n\n*(truncated; full report at ${path})*`
					: run.report;

			return {
				content: [{ type: "text", text: capped }],
				details: {
					runId: run.id,
					path,
					sources: run.sources.map((source) => source.url),
					steps: run.steps.length,
				},
				// A research run is a dozen model calls Pi's loop never saw. Without
				// this the footer and /session report a turn that spent nothing.
				usage: usage.total,
			};
		},
	});
}
