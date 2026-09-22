import type { Config } from "./config.ts";
import { type FetchedPage, fetchPage } from "./fetcher.ts";
import {
	type DecisionAction,
	nextUnusedSeed,
	parseJsonReply,
	reportAfterMarker,
	sanitizeQuery,
	validateAction,
	validateAudit,
	validatePlan,
} from "./parsing.ts";
import {
	AUDIT_PROMPT,
	decisionPrompt,
	plannerPrompt,
	REPORT_MARKER,
	REPORT_PROMPT,
	untrusted,
} from "./prompts.ts";
import { renderSourceList, validateReport } from "./citations.ts";
import { formatHits, searxngSearch } from "./searxng.ts";
import { addUsage, emptyUsage } from "./usage.ts";
import { setPlan } from "./store.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { Plan, Run, SearchHit, Source, StepSnapshot } from "./types.ts";

/** One model call, provider-neutral. `stopReason` matters: a synthesis cut off by the output
 *  budget is recoverable, a normal stop is not. */
export interface Completion {
	text: string;
	/** What this call cost. Summed across the run and handed back to Pi, which
	 *  cannot see calls that bypass its agent loop. */
	usage?: Usage;
	/** The thinking block, when the model produced one. A thinking model often
	 *  reasons its way to the answer and then stops, leaving the content empty
	 *  and the JSON here. */
	reasoning: string;
	stopReason: string;
}

export interface Caller {
	(input: {
		system: string;
		user: string;
		maxTokens?: number;
		/** This call must answer with a JSON object. Thinking is turned down for
		 *  it: the budget is better spent on the object than on deliberating
		 *  about it, and a model that thinks its whole budget away returns
		 *  nothing at all. */
		json?: boolean;
		signal: AbortSignal;
	}): Promise<Completion>;
}

export type ProgressEvent =
	| { type: "phase"; phase: string; detail?: string }
	| { type: "plan"; plan: Plan }
	| { type: "step"; position: number; action: string; title: string; input: string }
	| { type: "sources"; count: number; total: number }
	| { type: "note"; text: string };

export type OnProgress = (event: ProgressEvent) => void;

const CHARS_PER_TOKEN = 3.2;
const OUTPUT_RESERVE_TOKENS = 4096;
const MIN_EVIDENCE_CHARS = 1500;
const MAX_EVIDENCE_CHARS = 40_000;
const MAX_STEP_NOTE_CHARS = 8_000;

/** The loop's two side effects, injected so the loop can be tested without a network. */
export interface Tools {
	search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
	fetch(url: string, signal: AbortSignal): Promise<FetchedPage>;
}

export interface EngineOptions {
	config: Config;
	call: Caller;
	/** Mutated as the run proceeds; read by the caller when it finishes. */
	usage?: { total: Usage };
	tools?: Tools;
	/** Model context window in tokens, when the host knows it. */
	contextWindow?: number;
	onProgress: OnProgress;
	signal: AbortSignal;
	save: (run: Run) => Promise<void>;
}

/** One call, with its cost folded into the run's total. */
async function callCounted(options: EngineOptions, input: Parameters<Caller>[0]): Promise<Completion> {
	const completion = await options.call(input);
	if (options.usage) options.usage.total = addUsage(options.usage.total, completion.usage);
	return completion;
}

function tools(options: EngineOptions): Tools {
	return (
		options.tools ?? {
			search: (query, signal) => searxngSearch(options.config, query, signal),
			fetch: (url, signal) => fetchPage(options.config, url, signal),
		}
	);
}

function promptBudget(options: EngineOptions): number {
	const window = options.contextWindow ?? 128_000;
	const usable = Math.max(4_000, window - OUTPUT_RESERVE_TOKENS);
	return Math.floor(usable * CHARS_PER_TOKEN);
}

/** What is left for the trimmable section once the fixed scaffold is accounted for. */
function remaining(total: number, fixed: number, cap: number): number {
	return Math.max(0, Math.min(cap, total - fixed));
}

export async function planRun(run: Run, options: EngineOptions): Promise<Plan> {
	options.onProgress({ type: "phase", phase: "planning" });

	const system = plannerPrompt(run.budgets.maxSteps, run.currentDate, run.websitePolicy);
	const budget = promptBudget(options);
	const question = run.question.slice(0, remaining(budget, system.length, MAX_EVIDENCE_CHARS));

	const response = await callCounted(options, {
		system,
		user: `Research request:\n${untrusted(question)}`,
		maxTokens: 2048,
		json: true,
		signal: options.signal,
	});

	const plan = validatePlan(parseJsonReply(response.text, response.reasoning), run.budgets.maxSteps);
	setPlan(run, plan);
	run.status = "awaiting_approval";
	await options.save(run);
	options.onProgress({ type: "plan", plan });
	return plan;
}

function renderCatalog(sources: Source[], limit: number): string {
	const lines = sources.map((source, index) => `${index + 1}. ${source.title} | ${source.url}`);
	let out = lines.join("\n");
	// Trim from the front: the newest sources are the ones the current decision is about.
	while (out.length > limit && lines.length > 1) {
		lines.shift();
		out = lines.join("\n");
	}
	return out.slice(-limit);
}

async function decide(
	run: Run,
	options: EngineOptions,
	notes: string[],
	usedQueries: Set<string>,
	remainingActions: number,
): Promise<DecisionAction | null> {
	const system = decisionPrompt(run.websitePolicy);
	const budget = promptBudget(options);
	const planJson = JSON.stringify(run.plan);
	const stateJson = JSON.stringify(run.researchState ?? {});
	const historyJson = JSON.stringify([...usedQueries].sort());

	const scaffold =
		system.length + run.question.length + planJson.length + stateJson.length + historyJson.length;
	const catalog = renderCatalog(
		run.sources,
		remaining(budget, scaffold + MIN_EVIDENCE_CHARS, 8_000),
	);
	const evidenceChars = remaining(budget, scaffold + catalog.length, MAX_EVIDENCE_CHARS);
	const evidence = notes.join("\n\n").slice(-evidenceChars);

	const response = await callCounted(options, {
		system,
		user:
			`Question:\n${untrusted(run.question)}\n\n` +
			`Approved plan (guidance only):\n${untrusted(planJson)}\n\n` +
			`Actions remaining after this one: ${remainingActions}\n\n` +
			`<untrusted_history>\n${untrusted(historyJson)}\n</untrusted_history>\n\n` +
			`<untrusted_state>\n${untrusted(stateJson)}\n</untrusted_state>\n\n` +
			`<untrusted_evidence>\nGathered sources:\n${untrusted(catalog) || "(none)"}\n\n` +
			`${untrusted(evidence) || "(none)"}\n</untrusted_evidence>`,
		maxTokens: 1536,
		json: true,
		signal: options.signal,
	});

	try {
		return validateAction(
			parseJsonReply(response.text, response.reasoning),
			new Set(run.sources.map((s) => s.url)),
		);
	} catch {
		return null;
	}
}

function seedAction(run: Run, usedQueries: Set<string>): DecisionAction | null {
	const seed = nextUnusedSeed(run.plan!, usedQueries);
	if (!seed) return null;
	return { action: "search", title: seed.title, argument: seed.query, researchState: null };
}

export async function executeRun(run: Run, options: EngineOptions): Promise<string> {
	if (!run.plan) throw new Error("Cannot run without an approved plan");

	run.status = "running";
	await options.save(run);

	const notes: string[] = [];
	const usedQueries = new Set<string>();
	const fetchedUrls = new Set<string>();

	// Rebuild loop memory from persisted steps so a resumed run does not repeat itself.
	for (const step of run.steps) {
		const result = step.result;
		if (!result) continue;
		if (result.action === "fetch") fetchedUrls.add(result.input);
		else usedQueries.add(result.input.toLowerCase());
		if (step.status === "completed") {
			notes.push(
				`### ${step.title} (${result.action})\nInput: ${result.input}\n` +
					`${result.excerpt ?? ""}`.slice(0, MAX_STEP_NOTE_CHARS),
			);
		}
	}

	const io = tools(options);
	let gathered = run.steps.filter((step) => step.status === "completed").length;
	let lastError = "";

	for (let position = run.steps.length; position < run.budgets.maxSteps; position++) {
		if (options.signal.aborted) throw new Error("aborted");

		options.onProgress({ type: "phase", phase: "decision", detail: `step ${position + 1}` });

		let action = await decide(
			run,
			options,
			notes,
			usedQueries,
			run.budgets.maxSteps - position - 1,
		);

		// Every rejection funnels to the same place: run the next unused plan query instead of
		// burning the iteration. When the plan is exhausted, the loop is done.
		if (!action) action = seedAction(run, usedQueries);
		if (action && action.action === "finish") {
			if (action.researchState) run.researchState = action.researchState;
			if (gathered > 0) break;
			action = seedAction(run, usedQueries);
		}
		if (action && action.action === "search") {
			try {
				action.argument = sanitizeQuery(action.argument);
			} catch {
				action = seedAction(run, usedQueries);
			}
		}
		if (action) {
			const duplicate =
				action.action === "search"
					? usedQueries.has(action.argument.toLowerCase())
					: fetchedUrls.has(action.argument);
			if (duplicate) action = seedAction(run, usedQueries);
		}
		if (!action) break;

		// Persisted only once the action is final, so a rejected decision cannot leak its notes
		// into the executed step or into a later resume.
		if (action.researchState) run.researchState = action.researchState;

		const step: StepSnapshot = {
			position,
			title: action.title,
			query: action.argument,
			status: "running",
			startedAt: Date.now(),
		};
		run.steps.push(step);
		options.onProgress({
			type: "step",
			position,
			action: action.action,
			title: action.title,
			input: action.argument,
		});
		await options.save(run);

		const timeout = AbortSignal.any([
			options.signal,
			AbortSignal.timeout(run.budgets.toolTimeoutMs),
		]);

		try {
			if (action.action === "fetch") {
				fetchedUrls.add(action.argument);
				const page = await io.fetch(action.argument, timeout);
				notes.push(
					`### ${action.title} (fetch)\nInput: ${action.argument}\n${page.text}`.slice(
						0,
						MAX_STEP_NOTE_CHARS,
					),
				);
				step.result = {
					action: "fetch",
					input: action.argument,
					sourceCount: 0,
					sourceUrls: [],
					excerpt: page.text.slice(0, MAX_STEP_NOTE_CHARS),
					researchState: run.researchState ?? undefined,
				};
			} else {
				usedQueries.add(action.argument.toLowerCase());
				const hits = await io.search(action.argument, timeout);
				const added: Source[] = [];
				// Runs created before this budget existed keep their old behaviour.
				const perStep = run.budgets.maxSourcesPerStep ?? run.budgets.maxSources;
				for (const hit of hits) {
					if (added.length >= perStep) break;
					if (run.sources.length + added.length >= run.budgets.maxSources) break;
					if (run.sources.some((source) => source.url === hit.url)) continue;
					added.push({
						title: hit.title,
						url: hit.url,
						snippet: hit.content,
						stepPosition: position,
						fetchedAt: Date.now(),
					});
				}
				run.sources.push(...added);
				options.onProgress({
					type: "sources",
					count: added.length,
					total: run.sources.length,
				});

				let body = formatHits(hits);
				// Snippets rarely settle a technical claim, so the top results are read in full
				// and appended to them. Additive, not a replacement: the snippet set is what
				// tells the decision model what else is out there.
				const scraped: string[] = [];
				for (const hit of added.slice(0, run.budgets.maxScrapePerStep)) {
					if (fetchedUrls.has(hit.url)) continue;
					try {
						const page = await io.fetch(hit.url, timeout);
						fetchedUrls.add(hit.url);
						scraped.push(`Full text of ${page.url}:\n${page.text.slice(0, 6000)}`);
					} catch {
						// A page that will not load is not a failed step; the snippet still counts.
					}
				}
				if (scraped.length > 0) body += `\n\n---\n\n${scraped.join("\n\n---\n\n")}`;

				if (hits.length === 0) throw new Error("no results");

				notes.push(
					`### ${action.title} (search)\nInput: ${action.argument}\n${body}`.slice(
						0,
						MAX_STEP_NOTE_CHARS,
					),
				);
				step.result = {
					action: "search",
					input: action.argument,
					sourceCount: added.length,
					sourceUrls: added.map((source) => source.url),
					excerpt: scraped.length > 0 ? body.slice(0, MAX_STEP_NOTE_CHARS) : undefined,
					researchState: run.researchState ?? undefined,
				};
			}
			step.status = "completed";
			gathered++;
		} catch (error) {
			if (options.signal.aborted) throw error;
			lastError = (error as Error).message;
			step.status = "failed";
			step.result = {
				action: action.action === "fetch" ? "fetch" : "search",
				input: action.argument,
				sourceCount: 0,
				sourceUrls: [],
				error: lastError.slice(0, 500),
			};
			options.onProgress({ type: "note", text: `step failed: ${lastError}` });
		}
		step.completedAt = Date.now();
		await options.save(run);
	}

	if (gathered === 0 || run.sources.length === 0) {
		throw new Error(`No research step gathered any evidence. ${lastError}`.trim());
	}

	return synthesize(run, options, notes);
}

async function synthesize(run: Run, options: EngineOptions, notes: string[]): Promise<string> {
	const knownUrls = new Set(run.sources.map((source) => source.url));
	const catalog = run.sources
		.map((source, index) => `${index + 1}. Title: ${source.title}\n   URL: ${source.url}`)
		.join("\n");
	const planJson = JSON.stringify(run.plan);
	const budget = promptBudget(options);

	options.onProgress({ type: "phase", phase: "audit" });

	const auditScaffold =
		AUDIT_PROMPT.length + run.question.length + planJson.length + catalog.length;
	const auditEvidence = notes
		.join("\n\n")
		.slice(-remaining(budget, auditScaffold, MAX_EVIDENCE_CHARS));

	try {
		const response = await callCounted(options, {
			system: AUDIT_PROMPT,
			user:
				`<research_question>\n${untrusted(run.question)}\n</research_question>\n\n` +
				`<approved_plan>\n${untrusted(planJson)}\n</approved_plan>\n\n` +
				`<source_catalog>\n${untrusted(catalog)}\n</source_catalog>\n\n` +
				`<untrusted_evidence>\n${untrusted(auditEvidence)}\n</untrusted_evidence>`,
			maxTokens: 2048,
			json: true,
			signal: options.signal,
		});
		run.audit = validateAudit(parseJsonReply(response.text, response.reasoning), knownUrls);
	} catch {
		// The audit sharpens the report; it does not gate it. Losing it costs quality, not the run.
		run.audit = null;
		options.onProgress({ type: "note", text: "audit pass failed; writing report without it" });
	}
	await options.save(run);

	options.onProgress({ type: "phase", phase: "synthesis" });

	const auditJson = JSON.stringify(run.audit ?? {});
	const stateJson = JSON.stringify(run.researchState ?? {});
	const reportScaffold =
		REPORT_PROMPT.length +
		run.question.length +
		planJson.length +
		catalog.length +
		auditJson.length +
		stateJson.length;
	const evidence = notes.join("\n\n").slice(-remaining(budget, reportScaffold, MAX_EVIDENCE_CHARS));

	const user =
		`<research_question>\n${untrusted(run.question)}\n</research_question>\n\n` +
		`<approved_plan>\n${untrusted(planJson)}\n</approved_plan>\n\n` +
		`<source_catalog>\n${untrusted(catalog)}\n</source_catalog>\n\n` +
		`<untrusted_state>\n${untrusted(stateJson)}\n</untrusted_state>\n\n` +
		`<untrusted_audit>\n${untrusted(auditJson)}\n</untrusted_audit>\n\n` +
		`<untrusted_evidence>\n${untrusted(evidence)}\n</untrusted_evidence>`;

	const first = await callCounted(options, {
		system: REPORT_PROMPT,
		user,
		maxTokens: 16_384,
		signal: options.signal,
	});

	let draft = reportAfterMarker(first.text, REPORT_MARKER) || reportAfterMarker(first.reasoning, REPORT_MARKER);
	let truncated = first.stopReason === "length";

	// A missing marker means the model buried the report in its own commentary; an exhausted
	// budget means it stopped mid-sentence. One retry addresses both, and the better of the two
	// drafts wins -- measured after validation, so a draft cannot win on padding about to be cut.
	if (!draft || truncated) {
		options.onProgress({ type: "phase", phase: "recovery" });
		try {
			const retry = await callCounted(options, {
				system:
					`${REPORT_PROMPT}\n\nThe previous attempt ${
						truncated ? "ran out of output budget" : "did not emit the required marker"
					}. Write the report directly, starting with the marker on its own line. Be ` +
					"complete but do not pad.",
				user,
				maxTokens: 16_384,
				signal: options.signal,
			});
			const recovered =
				reportAfterMarker(retry.text, REPORT_MARKER) ||
				reportAfterMarker(retry.reasoning, REPORT_MARKER) ||
				retry.text.trim();
			const better =
				retry.stopReason !== "length" ||
				validateReport(recovered, run.sources).length > validateReport(draft, run.sources).length;
			if (better && recovered) {
				draft = recovered;
				truncated = retry.stopReason === "length";
			}
		} catch {
			// Keep the first draft rather than losing a run that already did its research.
		}
	}

	let report = validateReport(draft, run.sources);
	if (!report) throw new Error("The model produced no identifiable final report");

	// Above the report, not below: a report cut off mid-fence swallows anything appended under
	// it, and the reader should learn it is incomplete before reading it.
	if (truncated) {
		report = `> **Incomplete report.** The model reached its output limit; the text below stops early.\n\n${report}`;
	}

	report += renderSourceList(run.sources);

	run.report = report;
	run.status = "completed";
	run.completedAt = Date.now();
	await options.save(run);
	return report;
}
