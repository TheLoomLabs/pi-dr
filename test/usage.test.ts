import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { executeRun, planRun, type Caller } from "../src/engine.ts";
import { addUsage, emptyUsage } from "../src/usage.ts";

function usage(input: number, output: number, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("usage sums across calls", () => {
	const total = addUsage(addUsage(emptyUsage(), usage(100, 20, 0.5)), usage(5, 1, 0.25));
	assert.equal(total.input, 105);
	assert.equal(total.output, 21);
	assert.equal(total.totalTokens, 126);
	assert.equal(total.cost.total, 0.75);
});

test("a provider that reports no usage does not poison the total", () => {
	// Missing breakdowns must count as zero, not turn the running total to NaN.
	const total = addUsage(addUsage(emptyUsage(), usage(10, 2)), undefined);
	assert.equal(total.totalTokens, 12);
	assert.equal(Number.isNaN(total.cost.total), false);

	const partial = addUsage(emptyUsage(), { input: 5, output: 1 } as unknown as Usage);
	assert.equal(Number.isNaN(partial.totalTokens), false);
	assert.equal(Number.isNaN(partial.cost.total), false);
});

test("optional fields appear only when a provider reported them", () => {
	assert.equal("reasoning" in addUsage(emptyUsage(), usage(1, 1)), false);
	const withReasoning = addUsage(emptyUsage(), { ...usage(1, 1), reasoning: 7 });
	assert.equal(withReasoning.reasoning, 7);
});

test("every model call a run makes lands in the run's total", async () => {
	// The bug this pins: a research run is a dozen model calls that bypass Pi's
	// agent loop, so the footer showed a turn that apparently spent nothing.
	const counted = { total: emptyUsage() };
	const call: Caller = async ({ system }) => {
		const text = system.includes("Draft a web research plan")
			? '{"title":"T","steps":[{"title":"S","query":"a query"}]}'
			: system.includes("steering a research loop")
				? '{"action":"finish","title":"done"}'
				: system.includes("Audit the gathered evidence")
					? "{}"
					: "<!-- PI_DR_FINAL_REPORT -->\nBody [A](https://a.example/1).";
		return { text, reasoning: "", stopReason: "stop", usage: usage(1_000, 100) };
	};

	const base = {
		config: (await import("../src/config.ts")).loadConfig(),
		call,
		usage: counted,
		contextWindow: 32_000,
		onProgress: () => {},
		signal: new AbortController().signal,
		save: async () => {},
	};

	const run = {
		id: "t",
		question: "q",
		status: "planning" as const,
		plan: null,
		planRevision: 0,
		planHash: null,
		steps: [],
		sources: [],
		researchState: null,
		audit: null,
		report: null,
		error: null,
		budgets: { maxSteps: 2, maxSources: 5, maxSourcesPerStep: 5, maxScrapePerStep: 0, toolTimeoutMs: 5_000 },
		websitePolicy: { allowedDomains: [], blockedDomains: [] },
		model: "m",
		currentDate: "2026-09-22",
		createdAt: 0,
		updatedAt: 0,
	};

	await planRun(run, base);
	assert.equal(counted.total.totalTokens, 1_100, "planning counts");

	const tools = {
		async search() {
			return [{ title: "A", url: "https://a.example/1", content: "x" }];
		},
		async fetch(url: string) {
			return { url, title: "A", text: "text" };
		},
	};
	await executeRun(run, { ...base, tools });

	// Planner, at least one decision, the audit and the report — every one of
	// them billed.
	assert.ok(counted.total.totalTokens >= 4_400, `only ${counted.total.totalTokens} counted`);
	assert.equal(counted.total.totalTokens % 1_100, 0);
});
