import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { indicatorRunning, startIndicator, stopIndicator } from "../src/indicator.ts";

/** A ctx retired by a session replacement: every property access throws. */
function staleCtx(): ExtensionContext {
	return {
		get hasUI(): boolean {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	} as unknown as ExtensionContext;
}

function liveCtx(): { ctx: ExtensionContext; statuses: (string | undefined)[] } {
	const statuses: (string | undefined)[] = [];
	const ctx = {
		hasUI: true,
		ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
	} as unknown as ExtensionContext;
	return { ctx, statuses };
}

afterEach(() => {
	stopIndicator(liveCtx().ctx);
});

test("the poll starts with the session and stops with it", () => {
	const { ctx } = liveCtx();
	assert.equal(indicatorRunning(), false);
	startIndicator(ctx);
	assert.equal(indicatorRunning(), true);
	stopIndicator(ctx);
	assert.equal(indicatorRunning(), false);
});

test("starting twice leaves one poll, not two", () => {
	// A second session_start without a shutdown must not stack timers.
	const { ctx } = liveCtx();
	startIndicator(ctx);
	startIndicator(ctx);
	stopIndicator(ctx);
	assert.equal(indicatorRunning(), false);
});

test("stopping is idempotent and safe before anything started", () => {
	const { ctx, statuses } = liveCtx();
	assert.doesNotThrow(() => stopIndicator(ctx));
	assert.doesNotThrow(() => stopIndicator(ctx));
	// Clearing the line is the whole job of a stop that had nothing running.
	assert.deepEqual(statuses, [undefined, undefined]);
});

test("a run with no UI never starts the poll", () => {
	// Print and JSON modes have nothing to draw on, and each tick would spawn a
	// `docker info` nobody would ever see.
	const headless = { hasUI: false, ui: { setStatus: () => {} } } as unknown as ExtensionContext;
	startIndicator(headless);
	assert.equal(indicatorRunning(), false);
});

test("a retired ctx skips the repaint instead of taking the editor down", () => {
	// The pi-unsloth bug, which this extension must not repeat: a timer holding
	// a ctx whose session has been replaced throws on every property read, and
	// an unhandled rejection in a detached poll exits the process.
	assert.doesNotThrow(() => startIndicator(staleCtx()));
	assert.doesNotThrow(() => stopIndicator(staleCtx()));
});
