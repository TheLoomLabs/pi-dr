import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { backspace, field, forwardDelete, handleFieldKey, insert, moveEnd, moveHome, moveLeft, moveRight, withCursor } from "../src/ui/field.ts";
import { cardWidth, clip, elide, frame, hints, MAX_CARD_COLUMNS, MIN_CARD_COLUMNS, pad, wrap } from "../src/ui/frame.ts";
import { PlanEditor } from "../src/ui/plan-editor.ts";

const theme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

test("the card stops at a readable width however wide the terminal is", () => {
	// The bug this pins: 80% of a 240-column terminal is a 190-column card.
	assert.equal(cardWidth(240), MAX_CARD_COLUMNS);
	assert.equal(cardWidth(1000), MAX_CARD_COLUMNS);
	// And it still fills a small one, minus its margins.
	assert.equal(cardWidth(64), 60);
	// Never below the point where it stops being readable.
	assert.equal(cardWidth(20), MIN_CARD_COLUMNS);
});

test("every framed line is exactly the card's width", () => {
	const lines = frame("Title", ["short", "a".repeat(200), ""], 60, theme);
	for (const line of lines) assert.equal(visibleWidth(line), 60, line);
});

test("a title too long for the edge does not push the frame out", () => {
	const lines = frame("A title far longer than this narrow card", ["body"], 20, theme);
	for (const line of lines) assert.equal(visibleWidth(line), 20);
});

test("hints drop the rarest pair rather than overflowing", () => {
	const pairs: [string, string][] = [
		["a", "alpha"],
		["b", "bravo"],
		["c", "charlie"],
		["d", "delta"],
	];
	assert.ok(visibleWidth(hints(pairs, 80, theme)) <= 80);
	const narrow = hints(pairs, 20, theme);
	assert.ok(visibleWidth(narrow) <= 20, narrow);
	assert.match(narrow, /a alpha/);
	assert.doesNotMatch(narrow, /delta/);
});

test("clip keeps width, elide marks what it cut", () => {
	assert.equal(visibleWidth(clip("abcdefghij", 4)), 4);
	assert.equal(elide("abcdefghij", 4), "abc…");
	assert.equal(elide("abc", 10), "abc");
	assert.equal(visibleWidth(pad("ab", 6)), 6);
});

test("wrap breaks on words, hard-breaks a word that cannot fit, and elides the rest", () => {
	assert.deepEqual(wrap("one two three", 8, 2), ["one two", "three"]);
	assert.deepEqual(wrap("supercalifragilistic", 6, 1), ["super…"]);
	const two = wrap("alpha bravo charlie delta echo foxtrot", 12, 2);
	assert.equal(two.length, 2);
	assert.ok(two[1]?.endsWith("…"));
});

test("the text field edits at the caret, not at the end", () => {
	let f = field("abc");
	assert.equal(f.cursor, 3);
	f = moveHome(f);
	f = insert(f, "X");
	assert.equal(f.text, "Xabc");
	assert.equal(f.cursor, 1);
	f = moveEnd(f);
	f = backspace(f);
	assert.equal(f.text, "Xab");
	f = moveLeft(moveLeft(f));
	f = forwardDelete(f);
	assert.equal(f.text, "Xb");
});

test("backspace at the start and delete at the end are no-ops", () => {
	assert.equal(backspace(moveHome(field("abc"))).text, "abc");
	assert.equal(forwardDelete(field("abc")).text, "abc");
});

test("the field counts code points, so one keypress removes one character", () => {
	const f = backspace(field("naïve\u{1f600}"));
	assert.equal(f.text, "naïve");
});

test("the field ignores escape sequences and owns no enter or escape", () => {
	assert.equal(handleFieldKey(field("ab"), "\u001b[A"), undefined);
	assert.equal(handleFieldKey(field("ab"), "\u001b"), undefined);
	assert.equal(handleFieldKey(field("ab"), "c")?.text, "abc");
});

test("the caret is drawn where the cursor is", () => {
	assert.equal(withCursor(moveHome(field("ab"))), "▏ab");
	assert.equal(withCursor(field("ab")), "ab▏");
});

function editor(steps = 3): PlanEditor {
	return new PlanEditor(
		{
			title: "Plan",
			steps: Array.from({ length: steps }, (_, i) => ({ title: `Step ${i + 1}`, query: `query ${i + 1}` })),
		},
		theme,
		12,
	);
}

test("the plan editor renders a card of exactly the width it was given", () => {
	for (const width of [MIN_CARD_COLUMNS, 60, MAX_CARD_COLUMNS]) {
		for (const line of editor().render(width)) assert.equal(visibleWidth(line), width);
	}
});

test("editing a query renders it under the step, with a caret", () => {
	const e = editor();
	e.handleInput("e");
	const text = e.render(MAX_CARD_COLUMNS).join("\n");
	assert.match(text, /query 1▏/);
});

test("approval hands back the edited plan, escape hands back nothing", () => {
	const e = editor();
	let result: { plan: { steps: { query: string }[] }; approved: boolean } | null = null;
	e.onDone = (value) => {
		result = value as never;
	};
	e.handleInput("e");
	e.handleInput("!");
	e.handleInput("\r");
	e.handleInput("\r");
	assert.equal(result!.approved, true);
	assert.equal(result!.plan.steps[0]!.query, "query 1!");

	const cancelled = editor();
	let seen: unknown = "unset";
	cancelled.onDone = (value) => {
		seen = value;
	};
	cancelled.handleInput("\u001b");
	assert.equal(seen, null);
});

test("reordering moves the step and the selection together", () => {
	const e = editor();
	let plan: { steps: { title: string }[] } | undefined;
	e.onDone = (value) => {
		plan = value?.plan as never;
	};
	e.handleInput("J");
	e.handleInput("\r");
	assert.deepEqual(plan!.steps.map((s) => s.title), ["Step 2", "Step 1", "Step 3"]);
});

test("the last step cannot be deleted, and the step cap is enforced", () => {
	const one = new PlanEditor({ title: "P", steps: [{ title: "only", query: "q" }] }, theme, 1);
	one.handleInput("d");
	assert.match(one.render(MAX_CARD_COLUMNS).join("\n"), /A plan needs at least one step/);
	one.handleInput("a");
	assert.match(one.render(MAX_CARD_COLUMNS).join("\n"), /1-step limit/);
});

test("a step added and then abandoned does not stay in the plan", () => {
	const e = editor();
	let plan: { steps: unknown[] } | undefined;
	e.onDone = (value) => {
		plan = value?.plan as never;
	};
	e.handleInput("a");
	e.handleInput("\u001b");
	e.handleInput("\r");
	assert.equal(plan!.steps.length, 3);
});
