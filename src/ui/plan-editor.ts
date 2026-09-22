import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	bodyRows,
	clip,
	FRAME_CHROME,
	frame,
	hints,
	pad,
	strong,
	wrap,
	type FrameTheme,
} from "./frame.ts";
import { field, handleFieldKey, withCursor, type Field } from "./field.ts";
import type { Plan, PlanStep } from "../types.ts";

export interface PlanEditorResult {
	plan: Plan;
	approved: boolean;
}

type Mode = "list" | "query" | "title" | "planTitle";

/** Rows one step costs in the list. Fixed, so moving the cursor never reflows
 *  the list under it — a list that shifts as you scroll is hard to aim at. */
const ROWS_PER_STEP = 2;

/** Rows the header and the hint row cost, around the list. */
const CHROME_ROWS = 5;

/** The gutter: a selection bar, then the step number, then the text. */
const INDENT = 6;

/**
 * Reviewing and rewriting the plan before any of it runs.
 *
 * Editing happens inside this component rather than by opening a nested dialog:
 * an overlay has to give up input and reclaim it for every field, and a plan
 * step is one line of text — a field is the whole requirement.
 */
export class PlanEditor {
	private plan: Plan;
	private selected = 0;
	private top = 0;
	private mode: Mode = "list";
	private buffer: Field = field("");
	private message = "";
	private readonly theme: FrameTheme;
	private readonly maxSteps: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onDone?: (result: PlanEditorResult | null) => void;

	constructor(plan: Plan, theme: FrameTheme, maxSteps: number) {
		// Deep copy: nothing typed here touches the stored plan until approval
		// hands it back.
		this.plan = { title: plan.title, steps: plan.steps.map((step) => ({ ...step })) };
		this.theme = theme;
		this.maxSteps = maxSteps;
	}

	handleInput(data: string): void {
		this.message = "";
		if (this.mode === "list") this.handleListKey(data);
		else this.handleEditKey(data);
		this.invalidate();
	}

	private handleListKey(data: string): void {
		if (matchesKey(data, Key.up)) return this.select(this.selected - 1);
		if (matchesKey(data, Key.down)) return this.select(this.selected + 1);
		if (matchesKey(data, Key.home)) return this.select(0);
		if (matchesKey(data, Key.end)) return this.select(this.plan.steps.length - 1);
		if (matchesKey(data, Key.enter)) {
			this.onDone?.({ plan: this.plan, approved: true });
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.onDone?.(null);
			return;
		}

		switch (data) {
			case "e":
				this.mode = "query";
				this.buffer = field(this.plan.steps[this.selected]?.query ?? "");
				return;
			case "t":
				this.mode = "title";
				this.buffer = field(this.plan.steps[this.selected]?.title ?? "");
				return;
			case "T":
				this.mode = "planTitle";
				this.buffer = field(this.plan.title);
				return;
			case "a":
				if (this.plan.steps.length >= this.maxSteps) {
					this.message = `The plan is at its ${this.maxSteps}-step limit.`;
					return;
				}
				this.plan.steps.splice(this.selected + 1, 0, { title: "New step", query: "" });
				this.select(this.selected + 1);
				this.mode = "query";
				this.buffer = field("");
				return;
			case "d":
				if (this.plan.steps.length <= 1) {
					this.message = "A plan needs at least one step.";
					return;
				}
				this.plan.steps.splice(this.selected, 1);
				this.select(Math.min(this.selected, this.plan.steps.length - 1));
				return;
			case "J":
				return this.swap(this.selected + 1);
			case "K":
				return this.swap(this.selected - 1);
			default:
				return;
		}
	}

	private select(index: number): void {
		this.selected = Math.max(0, Math.min(this.plan.steps.length - 1, index));
		const visible = this.visibleSteps();
		// Keep the cursor inside the window, scrolling by the minimum needed.
		if (this.selected < this.top) this.top = this.selected;
		else if (this.selected >= this.top + visible) this.top = this.selected - visible + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.plan.steps.length - visible)));
	}

	private swap(target: number): void {
		if (target < 0 || target >= this.plan.steps.length) return;
		const steps = this.plan.steps;
		const moved = steps[this.selected] as PlanStep;
		steps[this.selected] = steps[target] as PlanStep;
		steps[target] = moved;
		this.select(target);
	}

	private handleEditKey(data: string): void {
		if (matchesKey(data, Key.escape)) {
			// A step added and then abandoned would otherwise sit in the plan
			// with no query at all.
			if (this.mode === "query" && !this.plan.steps[this.selected]?.query) {
				this.plan.steps.splice(this.selected, 1);
				this.select(this.selected);
			}
			this.mode = "list";
			return;
		}
		if (matchesKey(data, Key.enter)) return this.commit();

		const next = handleFieldKey(this.buffer, data);
		if (next) this.buffer = next;
	}

	private commit(): void {
		const value = this.buffer.text.trim();
		if (this.mode === "planTitle") {
			if (value) this.plan.title = value.slice(0, 200);
			this.mode = "list";
			return;
		}

		const step = this.plan.steps[this.selected];
		if (!step) {
			this.mode = "list";
			return;
		}
		if (this.mode === "query") {
			if (!value) {
				this.message = "A step needs a query. Escape drops the step.";
				return;
			}
			step.query = value.slice(0, 400);
			if (step.title === "New step") step.title = value.slice(0, 60);
		} else if (value) {
			step.title = value.slice(0, 120);
		}
		this.mode = "list";
	}

	/** How many steps fit, given how tall the terminal is right now.
	 *  An edited query may take a second row, so the window gives that row back
	 *  rather than letting the card grow past its share of the screen. */
	private visibleSteps(): number {
		const spare = this.mode === "query" ? 1 : 0;
		return Math.max(1, Math.floor((bodyRows() - CHROME_ROWS - spare) / ROWS_PER_STEP));
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const { theme } = this;
		const inner = Math.max(20, width - FRAME_CHROME);
		const visible = this.visibleSteps();
		const shown = this.plan.steps.slice(this.top, this.top + visible);
		const body: string[] = [];

		// Header: the plan's title, and on the right how much of it you are
		// looking at — only when there is more than fits.
		const counter =
			this.plan.steps.length > visible
				? `${this.top + 1}–${this.top + shown.length} of ${this.plan.steps.length}`
				: `${this.plan.steps.length} ${this.plan.steps.length === 1 ? "step" : "steps"}`;
		const titleText = this.mode === "planTitle" ? withCursor(this.buffer) : this.plan.title;
		const titleWidth = Math.max(8, inner - counter.length - 2);
		body.push(
			pad(theme.fg("text", strong(theme, clip(titleText, titleWidth))), inner - counter.length) +
				theme.fg("dim", counter),
		);
		body.push("");

		shown.forEach((step, offset) => {
			const index = this.top + offset;
			const active = index === this.selected;
			const bar = active ? theme.fg("accent", "▌") : " ";
			const number = String(index + 1).padStart(2);

			const editingTitle = active && this.mode === "title";
			const titleLine = editingTitle ? withCursor(this.buffer) : step.title;
			body.push(
				`${bar} ${theme.fg(active ? "accent" : "dim", number)}  ` +
					clip(theme.fg(active ? "text" : "muted", titleLine), inner - INDENT),
			);

			const editingQuery = active && this.mode === "query";
			const queryText = editingQuery ? withCursor(this.buffer) : step.query || "(no query yet)";
			// The edited query may take both of the step's rows; a resting one
			// gets one, so the list keeps a steady rhythm.
			const lines = wrap(queryText, inner - INDENT, editingQuery ? 2 : 1);
			const token = editingQuery ? "text" : step.query ? "dim" : "warning";
			for (const line of lines.length > 0 ? lines : [""]) {
				body.push(`${bar} ${" ".repeat(INDENT - 2)}${theme.fg(token, line)}`);
			}
		});

		body.push("");
		body.push(this.footer(inner));

		this.cachedLines = frame("Research plan", body, width, theme);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private footer(inner: number): string {
		const { theme } = this;
		if (this.message) return clip(theme.fg("warning", this.message), inner);
		if (this.mode !== "list") {
			const what = this.mode === "query" ? "query" : this.mode === "title" ? "step title" : "plan title";
			return hints(
				[
					["⏎", `save ${what}`],
					["esc", "cancel"],
					["←→", "move"],
				],
				inner,
				theme,
			);
		}
		return hints(
			[
				["↑↓", "select"],
				["⏎", "approve"],
				["e", "query"],
				["t", "title"],
				["a", "add"],
				["d", "delete"],
				["J/K", "reorder"],
				["T", "plan title"],
				["esc", "cancel"],
			],
			inner,
			theme,
		);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
