import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readStatus, statusLine } from "./status.ts";

/**
 * The always-visible answer to "is search up".
 *
 * A dot in Pi's footer, because the hub's indicator only exists while the hub
 * is open and the question "did my container die" is one you have when you are
 * doing something else.
 *
 * Two rules learned the hard way, both about a ctx outliving its session:
 * background work is started in `session_start` and stopped in
 * `session_shutdown`, and every ctx read is total — a timer that fires one tick
 * after a session is replaced must skip a repaint, not take the editor down.
 */

const STATUS_KEY = "deep-research";

/** Slow on purpose: a container's state changes on the scale of minutes, and
 *  this is a dot, not a dashboard. */
const POLL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | undefined;
let lifetime: AbortController | undefined;

/** `ctx.hasUI`, answering false instead of throwing on a retired ctx. */
function hasUI(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

function paint(ctx: ExtensionContext, text: string | undefined): void {
	if (!hasUI(ctx)) return;
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// The session went while we were drawing. Nothing to draw on now.
	}
}

export async function refreshIndicator(ctx: ExtensionContext): Promise<void> {
	const signal = lifetime?.signal ?? new AbortController().signal;
	if (signal.aborted) return;
	try {
		const status = await readStatus(signal);
		if (signal.aborted) return;
		const line = statusLine(status);
		const glyph = status.answering ? "●" : "○";
		paint(ctx, `${glyph} searxng ${line.text.split(" · ")[0]}`);
	} catch {
		if (!signal.aborted) paint(ctx, "○ searxng unknown");
	}
}

export function startIndicator(ctx: ExtensionContext): void {
	stopIndicator(ctx, { clear: false });
	// Nothing to draw on in print, JSON or RPC-without-UI runs, and the poll
	// spawns `docker info` every tick — work nobody would ever see.
	if (!hasUI(ctx)) return;
	lifetime = new AbortController();
	void refreshIndicator(ctx);
	timer = setInterval(() => {
		void refreshIndicator(ctx);
	}, POLL_MS);
	// The indicator must never be the reason Pi cannot exit.
	timer.unref?.();
}

/** Idempotent, and safe in a session that never started one. */
export function stopIndicator(ctx: ExtensionContext, options: { clear?: boolean } = {}): void {
	lifetime?.abort();
	lifetime = undefined;
	if (timer) clearInterval(timer);
	timer = undefined;
	if (options.clear !== false) paint(ctx, undefined);
}

/** Test seam: is a poll currently registered? */
export function indicatorRunning(): boolean {
	return timer !== undefined;
}
