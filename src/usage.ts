import type { Usage } from "@earendil-works/pi-ai";

/**
 * Adding up what the research actually cost.
 *
 * A run makes a dozen or more model calls of its own — plan, a decision per
 * step, the audit, the report — and none of them go through the agent loop, so
 * Pi cannot see them. Left unreported, the footer and `/session` show a turn
 * that apparently spent nothing while the GPU was busy for two minutes.
 *
 * Pi's contract for this is one line: a tool that makes nested LLM calls
 * returns their combined `Usage`, and Pi folds it into the footer, `/session`
 * and the session totals.
 */
export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Fold one call's usage into a running total. Absent fields count as zero:
 *  providers differ on which they report, and a missing breakdown must not
 *  turn the total into NaN. */
export function addUsage(total: Usage, next: Usage | undefined): Usage {
	if (!next) return total;
	const sum = (a: number | undefined, b: number | undefined): number => (a ?? 0) + (b ?? 0);
	return {
		input: sum(total.input, next.input),
		output: sum(total.output, next.output),
		cacheRead: sum(total.cacheRead, next.cacheRead),
		cacheWrite: sum(total.cacheWrite, next.cacheWrite),
		...(total.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined
			? { cacheWrite1h: sum(total.cacheWrite1h, next.cacheWrite1h) }
			: {}),
		...(total.reasoning !== undefined || next.reasoning !== undefined
			? { reasoning: sum(total.reasoning, next.reasoning) }
			: {}),
		totalTokens: sum(total.totalTokens, next.totalTokens),
		cost: {
			input: sum(total.cost?.input, next.cost?.input),
			output: sum(total.cost?.output, next.cost?.output),
			cacheRead: sum(total.cost?.cacheRead, next.cost?.cacheRead),
			cacheWrite: sum(total.cost?.cacheWrite, next.cost?.cacheWrite),
			total: sum(total.cost?.total, next.cost?.total),
		},
	};
}
