import { bodyRows, clip, elide, FRAME_CHROME, frame, hints, pad, type FrameTheme } from "./frame.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Rows the header and hint row cost around the activity log. */
const CHROME_ROWS = 5;

/** Width of the action column, so the inputs line up under each other. */
const ACTION_COLUMN = 7;

type Entry =
	| { kind: "step"; action: string; input: string; done: boolean }
	| { kind: "sources"; count: number; total: number }
	| { kind: "note"; text: string };

/**
 * A run in flight: what phase it is in, what it has done, and Escape to stop.
 *
 * The run itself is on disk, so stopping here loses the loop, not the research
 * — which is what the hint says, because otherwise nobody dares press it.
 */
export class ResearchMonitor {
	private readonly controller = new AbortController();
	private readonly theme: FrameTheme;
	private readonly requestRender: () => void;
	private readonly title: string;
	private frame = 0;
	private phase = "starting";
	private entries: Entry[] = [];
	private timer?: ReturnType<typeof setInterval>;

	public onAbort?: () => void;

	constructor(theme: FrameTheme, requestRender: () => void, title: string) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.title = title;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES.length;
			this.requestRender();
		}, 90);
		// The spinner must never be the reason the process cannot exit.
		this.timer.unref?.();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	setPhase(phase: string): void {
		this.phase = phase;
		this.requestRender();
	}

	/** A step started. The previous one is settled by the same call. */
	step(action: string, input: string): void {
		this.settle();
		this.push({ kind: "step", action, input, done: false });
	}

	sources(count: number, total: number): void {
		this.push({ kind: "sources", count, total });
	}

	note(text: string): void {
		this.push({ kind: "note", text });
	}

	/** Mark the running step finished, so the log reads as history. */
	settle(): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i] as Entry;
			if (entry.kind === "step") {
				entry.done = true;
				return;
			}
		}
	}

	private push(entry: Entry): void {
		this.entries.push(entry);
		// Only what fits is kept: the log is a progress report, not a record —
		// the run on disk is the record.
		const limit = Math.max(4, Math.floor((bodyRows() - CHROME_ROWS) / 1));
		if (this.entries.length > limit) this.entries.splice(0, this.entries.length - limit);
		this.requestRender();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	handleInput(data: string): void {
		// Escape, or ctrl-c, stops the loop.
		if (data === "\u001b" || data === "\u0003") {
			this.controller.abort();
			this.onAbort?.();
		}
	}

	render(width: number): string[] {
		const { theme } = this;
		const inner = Math.max(20, width - FRAME_CHROME);
		const body: string[] = [];

		body.push(
			`${theme.fg("accent", FRAMES[this.frame] as string)}  ${theme.fg("text", clip(this.title, inner - 3))}`,
		);
		body.push(`   ${theme.fg("muted", clip(this.phase, inner - 3))}`);
		body.push("");

		for (const entry of this.entries) {
			if (entry.kind === "step") {
				const glyph = entry.done ? theme.fg("success", "✓") : theme.fg("accent", "›");
				const action = theme.fg("muted", pad(entry.action, ACTION_COLUMN));
				body.push(`${glyph} ${action}${theme.fg("dim", elide(entry.input, inner - ACTION_COLUMN - 2))}`);
			} else if (entry.kind === "sources") {
				body.push(
					`  ${" ".repeat(ACTION_COLUMN)}${theme.fg("dim", `+${entry.count} sources · ${entry.total} total`)}`,
				);
			} else {
				body.push(`${theme.fg("warning", "!")} ${clip(theme.fg("muted", entry.text), inner - 2)}`);
			}
		}

		body.push("");
		// One key, then a reassurance: nobody presses `esc` on a long run unless
		// the line says what it costs.
		const stop = hints([["esc", "stop"]], inner, theme);
		body.push(clip(`${stop}${theme.fg("dim", "  \u00b7  progress is saved")}`, inner));

		return frame("Deep research", body, width, theme);
	}

	invalidate(): void {}
}
