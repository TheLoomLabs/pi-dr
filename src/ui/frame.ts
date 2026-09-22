import { visibleWidth } from "@earendil-works/pi-tui";
import type { OverlayOptions } from "@earendil-works/pi-tui";

/**
 * Where an overlay sits and what it is drawn in.
 *
 * The rule the whole file exists for: **a panel is a card, not a column of the
 * screen.** Sized as a share of the terminal it degenerates on a wide monitor —
 * a 240-column terminal gave a 190-column plan whose step titles sat at one end
 * of the line and nothing at all sat at the other. Reading is what a line
 * length is for, so the card stops at a readable width and centres, however
 * much desk there is.
 *
 * `OverlayOptions` has `minWidth` and `maxHeight` but no `maxWidth`, so the cap
 * cannot be expressed declaratively: the width is computed here, in columns,
 * per call, which also means a resize re-centres it.
 */

export type FrameToken = "accent" | "dim" | "muted" | "text" | "warning" | "success" | "error" | "border";

export interface FrameTheme {
	fg(color: FrameToken, text: string): string;
	bold?(text: string): string;
}

/** Bold when the theme offers it; plain when it does not. */
export function strong(theme: FrameTheme, text: string): string {
	return theme.bold ? theme.bold(text) : text;
}

/** The widest the card ever gets, however wide the terminal is. */
export const MAX_CARD_COLUMNS = 76;

/** Below this an overlay is unreadable, and an unreadable modal is worse than
 *  none: the command still works and reports through `notify`. */
export const MIN_CARD_COLUMNS = 48;

/** Breathing room kept either side on a narrow terminal. */
const CARD_MARGIN = 2;

/** Columns the frame costs: a border and a gutter on each side. */
export const FRAME_CHROME = 4;

/** Rows it costs: the titled top edge and the bottom edge. */
export const FRAME_ROWS = 2;

export function terminalColumns(): number {
	const value = process.stdout.columns;
	return typeof value === "number" && value > 0 ? value : 80;
}

export function terminalRows(): number {
	const value = process.stdout.rows;
	return typeof value === "number" && value > 0 ? value : 24;
}

/** How wide the card will actually be, for layout that has to know. */
export function cardWidth(columns: number = terminalColumns()): number {
	return Math.max(MIN_CARD_COLUMNS, Math.min(MAX_CARD_COLUMNS, columns - 2 * CARD_MARGIN));
}

/** The share of the terminal height a card may fill. Matches `maxHeight`. */
export const MAX_CARD_HEIGHT_SHARE = 0.8;

/** How many rows the whole card may occupy, frame included. */
export function cardRows(rows: number = terminalRows()): number {
	return Math.max(6, Math.floor(rows * MAX_CARD_HEIGHT_SHARE));
}

/** How many rows the body may use, once the frame has taken its own. */
export function bodyRows(rows: number = terminalRows()): number {
	return cardRows(rows) - FRAME_ROWS;
}

/** Shared by every overlay here, so one replacing another lands in the same
 *  place rather than jumping. */
export function cardGeometry(): OverlayOptions {
	return {
		anchor: "center",
		width: cardWidth(),
		maxHeight: "80%",
		visible: (width: number) => width >= MIN_CARD_COLUMNS,
	};
}

/** Pad to `width` visible columns. Never truncates — `clip` is for that. */
export function pad(text: string, width: number): string {
	const shown = visibleWidth(text);
	return shown >= width ? text : text + " ".repeat(width - shown);
}

/**
 * Clip a themed line to `width` visible columns.
 *
 * Counts only what is printed and keeps the escape sequences it passes, so a
 * coloured line can be cut without losing its reset.
 */
export function clip(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = "";
	let shown = 0;
	let at = 0;
	while (at < line.length && shown < width) {
		if (line[at] === "\u001b") {
			const end = line.indexOf("m", at);
			if (end === -1) break;
			out += line.slice(at, end + 1);
			at = end + 1;
			continue;
		}
		const character = line[at] as string;
		const step = visibleWidth(character);
		if (shown + step > width) break;
		out += character;
		shown += step;
		at += 1;
	}
	return out + (line.includes("\u001b") ? "\u001b[0m" : "");
}

/**
 * Cut plain text to `width`, marking that something was cut.
 *
 * For unthemed text on its way into a line — a URL, a query. `clip` is the
 * backstop for text that is already coloured and must not gain a character.
 */
export function elide(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return `${[...text].slice(0, Math.max(0, width - 1)).join("")}\u2026`;
}

/** Wrap plain text to `width`, at most `maxLines`, eliding the overflow. */
export function wrap(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";

	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (visibleWidth(candidate) <= width) {
			line = candidate;
			continue;
		}
		if (line) lines.push(line);
		// A single word longer than the line gets hard-broken rather than
		// pushing the card's right edge out.
		line = visibleWidth(word) <= width ? word : word.slice(0, width);
		if (lines.length === maxLines) break;
	}
	if (line && lines.length < maxLines) lines.push(line);

	if (lines.length === 0) return [];
	if (lines.length >= maxLines && words.join(" ") !== lines.join(" ")) {
		const last = lines[maxLines - 1] as string;
		lines[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
	}
	return lines.slice(0, maxLines);
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

/**
 * A titled, rounded box around a block of already-themed lines.
 *
 * A box *contains* its content, so a card narrower than the terminal reads as
 * one object rather than as text floating beside an empty screen — and the
 * title belongs on the edge, where every other modern terminal UI puts it,
 * rather than costing a line inside.
 *
 * Body lines arrive themed, so their width is measured rather than assumed and
 * each is padded before the right border goes on; otherwise the right edge
 * would follow the ragged text.
 */
export function frame(title: string, body: readonly string[], width: number, theme: FrameTheme): string[] {
	const inner = Math.max(1, width - FRAME_CHROME);
	const edge = (text: string): string => theme.fg("dim", text);

	const label = title === "" ? "" : ` ${title} `;
	const labelWidth = visibleWidth(label);
	const top =
		labelWidth + 4 <= width
			? edge(`${TOP_LEFT}${HORIZONTAL}`) +
				theme.fg("accent", strong(theme, label)) +
				edge(HORIZONTAL.repeat(Math.max(0, width - labelWidth - 3)) + TOP_RIGHT)
			: edge(TOP_LEFT + HORIZONTAL.repeat(Math.max(0, width - 2)) + TOP_RIGHT);

	const lines = body.map((line) => `${edge(VERTICAL)} ${pad(clip(line, inner), inner)} ${edge(VERTICAL)}`);

	return [top, ...lines, edge(BOTTOM_LEFT + HORIZONTAL.repeat(Math.max(0, width - 2)) + BOTTOM_RIGHT)];
}

/**
 * A key hint row: `↑↓ move · e query · ⏎ approve`.
 *
 * Takes the pairs in priority order and drops from the end until the row fits,
 * so a narrow terminal loses the rarest hint rather than wrapping the line or
 * having it clipped mid-word.
 */
export function hints(pairs: readonly [string, string][], width: number, theme: FrameTheme): string {
	const separator = theme.fg("dim", " · ");
	const render = (count: number): string =>
		pairs
			.slice(0, count)
			.map(([key, label]) => `${theme.fg("accent", key)} ${theme.fg("muted", label)}`)
			.join(separator);

	for (let count = pairs.length; count > 1; count--) {
		if (visibleWidth(render(count)) <= width) return render(count);
	}
	return clip(render(1), width);
}
