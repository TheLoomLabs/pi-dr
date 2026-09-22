import { Key, matchesKey } from "@earendil-works/pi-tui";
import { clip, elide, FRAME_CHROME, FRAME_ROWS, frame, hints, pad, strong, wrap, type FrameTheme } from "./frame.ts";
import { field, handleFieldKey, withCursor, type Field } from "./field.ts";
import { statusLine, toggleLabel, type SearchStatus } from "../status.ts";
import type { Run } from "../types.ts";

export type HomeAction =
	| { kind: "research"; question: string }
	/** Carries the draft so a detour through settings does not lose what was typed. */
	| { kind: "settings"; question: string }
	| { kind: "toggle" };

type Focus = "question" | "actions";

/**
 * Where `/research` starts: a question to type, what the search backend is
 * doing, and what has been researched here before.
 *
 * Tab moves between the question and the buttons rather than a chord doing it.
 * Chords were the first design and they do not work: `ctrl+t` is already
 * `app.thinking.toggle` in Pi, `ctrl+s` is XOFF on many terminals, and of the
 * whole ctrl range Pi leaves almost nothing free. A visible button that Tab
 * reaches cannot be stolen by a keybinding, and says what it does without a
 * legend.
 *
 * The history is not decoration: research questions are long and get retyped
 * with one word changed, so previous ones work like shell history.
 */
export class HomeCard {
	private readonly theme: FrameTheme;
	private buffer: Field;
	private runs: Run[];
	private status: SearchStatus | undefined;
	private busy = "";
	private message = "";
	private focus: Focus = "question";
	private action = 0;
	/** -1 is the field itself; 0.. index into the history. */
	private picked = -1;
	private draft = "";

	public onAction?: (action: HomeAction) => void;
	public onClose?: () => void;

	constructor(theme: FrameTheme, runs: Run[], question = "") {
		this.theme = theme;
		this.buffer = field(question);
		this.runs = runs;
	}

	setStatus(status: SearchStatus): void {
		this.status = status;
		this.busy = "";
	}

	setBusy(line: string): void {
		this.busy = line;
		this.message = "";
	}

	setMessage(text: string): void {
		this.message = text;
		this.busy = "";
	}

	setRuns(runs: Run[]): void {
		this.runs = runs;
	}

	/** The buttons, in the order they are drawn. */
	private actions(): { kind: "toggle" | "settings"; label: string; enabled: boolean }[] {
		const toggle = this.status ? toggleLabel(this.status) : { action: "none" as const, label: "checking" };
		return [
			{
				kind: "toggle",
				label:
					toggle.action === "start"
						? "Start search"
						: toggle.action === "stop"
							? "Stop search"
							: toggle.action === "none" && toggle.label === "install"
								? "Install search"
								: `Search: ${toggle.label}`,
				enabled: toggle.action !== "none",
			},
			{ kind: "settings", label: "Settings", enabled: true },
		];
	}

	handleInput(data: string): void {
		if (this.busy) return;
		this.message = "";

		if (matchesKey(data, Key.tab)) {
			this.focus = this.focus === "question" ? "actions" : "question";
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.focus === "actions") {
				this.focus = "question";
				return;
			}
			this.onClose?.();
			return;
		}

		if (this.focus === "actions") return this.handleActionKey(data);
		this.handleQuestionKey(data);
	}

	private handleActionKey(data: string): void {
		const actions = this.actions();
		if (matchesKey(data, Key.left) || matchesKey(data, Key.up)) {
			this.action = Math.max(0, this.action - 1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.down)) {
			this.action = Math.min(actions.length - 1, this.action + 1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const chosen = actions[this.action];
			if (!chosen) return;
			if (!chosen.enabled) {
				// Short enough to survive the card's width: a warning that gets
				// clipped mid-sentence is a warning nobody can act on.
				this.message =
					this.status && !this.status.ours
						? "Not a container we started — not ours to start or stop."
						: "No Docker or Podman on this machine.";
				return;
			}
			this.onAction?.(
				chosen.kind === "settings"
					? { kind: "settings", question: this.buffer.text }
					: { kind: "toggle" },
			);
		}
	}

	private handleQuestionKey(data: string): void {
		if (matchesKey(data, Key.enter)) {
			const question = this.buffer.text.trim();
			if (!question) {
				this.message = "Type a question first.";
				return;
			}
			this.onAction?.({ kind: "research", question });
			return;
		}
		if (matchesKey(data, Key.up)) return this.recall(1);
		if (matchesKey(data, Key.down)) return this.recall(-1);

		const next = handleFieldKey(this.buffer, data);
		if (next) {
			this.buffer = next;
			// Typing leaves the history: what is in the field is yours now.
			this.picked = -1;
		}
	}

	/** Walk the history like a shell's, keeping whatever was half-typed. */
	private recall(delta: number): void {
		if (this.runs.length === 0) return;
		if (this.picked === -1 && delta > 0) this.draft = this.buffer.text;

		const next = Math.max(-1, Math.min(this.runs.length - 1, this.picked + delta));
		if (next === this.picked) return;
		this.picked = next;
		this.buffer = field(next === -1 ? this.draft : (this.runs[next]?.question ?? ""));
	}

	/**
	 * Lay the fixed parts out first, then give the history whatever rows are
	 * left. Counted rather than estimated: a guessed chrome height is wrong the
	 * moment the question wraps to a second line, and the card then runs off the
	 * bottom of a short terminal.
	 */
	render(width: number, rows = 20): string[] {
		const { theme } = this;
		const inner = Math.max(20, width - FRAME_CHROME);

		const head: string[] = [theme.fg("muted", "What should I research?")];
		for (const line of wrap(withCursor(this.buffer), inner - 2, 3)) {
			head.push(
				`${theme.fg(this.focus === "question" ? "accent" : "dim", "▌")} ${theme.fg("text", line)}`,
			);
		}
		head.push("");
		head.push(this.searchRow(inner));
		head.push(this.actionRow(inner));
		head.push("");

		const foot: string[] = ["", this.footer(inner)];

		const room = rows - FRAME_ROWS - head.length - foot.length - 1;
		const shown = Math.max(0, Math.min(this.runs.length, room));

		const history: string[] = [];
		if (shown > 0) {
			history.push(theme.fg("muted", "Recent"));
			this.runs.slice(0, shown).forEach((run, index) => {
				const active = this.focus === "question" && index === this.picked;
				const bar = active ? theme.fg("accent", "▌") : " ";
				const glyph =
					run.status === "completed"
						? theme.fg("success", "✓")
						: run.status === "failed"
							? theme.fg("error", "×")
							: theme.fg("dim", "·");
				const meta = run.status === "completed" ? `${run.sources.length} sources` : run.status;
				const room = inner - 6 - meta.length;
				const question = elide(run.question.replace(/\s+/g, " "), Math.max(8, room));
				history.push(
					`${bar} ${glyph} ` +
						pad(theme.fg(active ? "text" : "dim", question), inner - 4 - meta.length) +
						theme.fg("dim", meta),
				);
			});
		}

		return frame("Deep research", [...head, ...history, ...foot], width, theme);
	}

	private searchRow(inner: number): string {
		const { theme } = this;
		if (this.busy) {
			return `${theme.fg("accent", "◌")} ${clip(theme.fg("muted", this.busy), inner - 2)}`;
		}
		if (!this.status) {
			return `${theme.fg("dim", "◌")} ${theme.fg("dim", "checking search backend…")}`;
		}
		const line = statusLine(this.status);
		return clip(
			`${theme.fg(line.token, "●")} ${theme.fg("muted", "SearXNG")} ${theme.fg("dim", line.text)}`,
			inner,
		);
	}

	private actionRow(inner: number): string {
		const { theme } = this;
		if (this.busy) return "";
		const focused = this.focus === "actions";
		const buttons = this.actions().map((button, index) => {
			const on = focused && index === this.action;
			const text = ` ${button.label} `;
			if (!button.enabled) return theme.fg("dim", `[${text}]`);
			if (on) return theme.fg("accent", strong(theme, `[${text}]`));
			return theme.fg("muted", `[${text}]`);
		});
		return clip(`  ${buttons.join(" ")}`, inner);
	}

	private footer(inner: number): string {
		const { theme } = this;
		if (this.message) return clip(theme.fg("warning", this.message), inner);
		if (this.busy) return theme.fg("dim", "working…");

		if (this.focus === "actions") {
			return hints(
				[
					["←→", "pick"],
					["⏎", "do it"],
					["tab", "back to question"],
				],
				inner,
				theme,
			);
		}
		return hints(
			[
				["⏎", "research"],
				["↑↓", "recent"],
				["tab", "search & settings"],
				["esc", "close"],
			],
			inner,
			theme,
		);
	}

	invalidate(): void {}
}
