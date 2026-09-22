import { Key, matchesKey } from "@earendil-works/pi-tui";

/**
 * A one-line text field: the text, and where the caret is in it.
 *
 * Pure and separate from drawing, because "backspace at the start is a no-op,
 * home then right lands on index 1, and typing inserts at the caret rather than
 * at the end" is a dozen rules that are each one line of test, versus a session
 * of typing into a modal to find the one that is wrong.
 *
 * Indices are code points, not UTF-16 units, so an emoji or an accented
 * character is one press of backspace rather than two and half a character.
 */
export interface Field {
	text: string;
	cursor: number;
}

const CURSOR = "▏";

export function field(text: string): Field {
	const points = [...text];
	return { text, cursor: points.length };
}

function fromPoints(points: string[], cursor: number): Field {
	return { text: points.join(""), cursor: Math.max(0, Math.min(points.length, cursor)) };
}

export function insert(current: Field, text: string): Field {
	const points = [...current.text];
	const added = [...text];
	points.splice(current.cursor, 0, ...added);
	return fromPoints(points, current.cursor + added.length);
}

export function backspace(current: Field): Field {
	if (current.cursor === 0) return current;
	const points = [...current.text];
	points.splice(current.cursor - 1, 1);
	return fromPoints(points, current.cursor - 1);
}

export function forwardDelete(current: Field): Field {
	const points = [...current.text];
	if (current.cursor >= points.length) return current;
	points.splice(current.cursor, 1);
	return fromPoints(points, current.cursor);
}

export function moveLeft(current: Field): Field {
	return { ...current, cursor: Math.max(0, current.cursor - 1) };
}

export function moveRight(current: Field): Field {
	return { ...current, cursor: Math.min([...current.text].length, current.cursor + 1) };
}

export function moveHome(current: Field): Field {
	return { ...current, cursor: 0 };
}

export function moveEnd(current: Field): Field {
	return { ...current, cursor: [...current.text].length };
}

/** The text with a caret drawn into it, ready to wrap and print. */
export function withCursor(current: Field): string {
	const points = [...current.text];
	return `${points.slice(0, current.cursor).join("")}${CURSOR}${points.slice(current.cursor).join("")}`;
}

/**
 * Fold one keypress into the field.
 *
 * Returns `undefined` for keys the field does not own — enter and escape, which
 * belong to whatever opened it — so the caller keeps one place that decides
 * what commits and what cancels.
 */
export function handleFieldKey(current: Field, data: string): Field | undefined {
	if (matchesKey(data, Key.backspace)) return backspace(current);
	if (matchesKey(data, Key.delete)) return forwardDelete(current);
	if (matchesKey(data, Key.left)) return moveLeft(current);
	if (matchesKey(data, Key.right)) return moveRight(current);
	if (matchesKey(data, Key.home)) return moveHome(current);
	if (matchesKey(data, Key.end)) return moveEnd(current);
	// Printable text only. Control sequences — arrows, function keys — arrive as
	// escape sequences and would otherwise be typed into the field as garbage.
	if (data.length > 0 && !data.startsWith("\u001b") && !/[\u0000-\u001f\u007f]/.test(data)) {
		return insert(current, data);
	}
	return undefined;
}
