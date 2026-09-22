import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { type Caller, type EngineOptions, executeRun, planRun } from "../src/engine.ts";
import { REPORT_MARKER } from "../src/prompts.ts";
import type { Run, SearchHit } from "../src/types.ts";

function makeRun(question: string, overrides: Partial<Run> = {}): Run {
	const config = loadConfig();
	return {
		id: "test",
		question,
		status: "planning",
		plan: null,
		planRevision: 0,
		planHash: null,
		steps: [],
		sources: [],
		researchState: null,
		audit: null,
		report: null,
		error: null,
		budgets: { ...config.budgets, maxSteps: 4, maxScrapePerStep: 0 },
		websitePolicy: { allowedDomains: [], blockedDomains: [] },
		model: "test-model",
		currentDate: "2026-09-22",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

/** A caller that answers each phase by matching on its system prompt, and records every call. */
function scriptedCaller(script: {
	plan?: string;
	decisions?: string[];
	audit?: string;
	report?: string[];
	/** Put every reply in the thinking block instead, as a thinking model does. */
	asThinking?: boolean;
}): { call: Caller; calls: string[]; jsonCalls: number } {
	const calls: string[] = [];
	const counters = { json: 0 };
	let decision = 0;
	let report = 0;
	const reply = (text: string, stopReason = "stop") =>
		script.asThinking
			? { text: "", reasoning: text, stopReason }
			: { text, reasoning: "", stopReason };

	const call: Caller = async ({ system, json }) => {
		if (json) counters.json++;
		if (system.includes("Draft a web research plan")) {
			calls.push("plan");
			return reply(script.plan ?? "");
		}
		if (system.includes("steering a research loop")) {
			calls.push("decide");
			const next = script.decisions?.[decision] ?? '{"action":"finish","title":"done"}';
			decision++;
			return reply(next);
		}
		if (system.includes("Audit the gathered evidence")) {
			calls.push("audit");
			return reply(script.audit ?? "{}");
		}
		calls.push("report");
		const text = script.report?.[report] ?? `${REPORT_MARKER}\nA report.`;
		report++;
		return reply(text);
	};
	return {
		call,
		calls,
		get jsonCalls() {
			return counters.json;
		},
	};
}

function fakeTools(hitsByQuery: Record<string, SearchHit[]>) {
	const searched: string[] = [];
	return {
		searched,
		tools: {
			async search(query: string): Promise<SearchHit[]> {
				searched.push(query);
				return hitsByQuery[query] ?? [];
			},
			async fetch(url: string) {
				return { url, title: `Title of ${url}`, text: `Full text of ${url}` };
			},
		},
	};
}

function options(call: Caller, extra: Partial<EngineOptions> = {}): EngineOptions {
	return {
		config: loadConfig(),
		call,
		contextWindow: 32_000,
		onProgress: () => {},
		signal: new AbortController().signal,
		save: async () => {},
		...extra,
	};
}

test("planRun stores a plan, hashes it, and stops for approval", async () => {
	const run = makeRun("what changed in HTTP/3 congestion control?");
	const { call } = scriptedCaller({
		plan: '{"title":"HTTP/3","steps":[{"title":"Spec","query":"http3 congestion control rfc"}]}',
	});

	await planRun(run, options(call));

	assert.equal(run.status, "awaiting_approval");
	assert.equal(run.planRevision, 1);
	assert.equal(run.planHash?.length, 64);
	assert.equal(run.plan?.steps.length, 1);
});

test("executeRun gathers sources, audits, and returns a validated cited report", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "first query" }] },
		planRevision: 1,
		planHash: "x".repeat(64),
	});
	const { tools, searched } = fakeTools({
		"first query": [
			{ title: "Good Source", url: "https://good.example/a", content: "evidence about q" },
		],
	});
	const { call, calls } = scriptedCaller({
		decisions: [
			'{"action":"search","title":"One","query":"first query","researchState":{"summary":"s","gaps":["g"],"unsupportedClaims":[],"nextBridge":""}}',
			'{"action":"finish","title":"done","researchState":{"summary":"s2","gaps":[],"unsupportedClaims":[],"nextBridge":""}}',
		],
		audit: '{"thesis":"t","outline":["A"],"supportedClaims":[{"claim":"c","sourceUrls":["https://good.example/a"]}]}',
		report: [
			`${REPORT_MARKER}\n## Finding\n\nIt is so [Whatever](https://good.example/a), unlike [Fake](https://bad.example/z).`,
		],
	});

	const report = await executeRun(run, options(call, { tools }));

	assert.deepEqual(searched, ["first query"]);
	assert.deepEqual(calls, ["decide", "decide", "audit", "report"]);
	assert.equal(run.status, "completed");
	assert.equal(run.sources.length, 1);
	assert.equal(run.researchState?.summary, "s2");
	assert.equal(run.audit?.supportedClaims.length, 1);
	// Catalog citation canonicalized, invented citation unlinked, source list generated.
	assert.match(report, /\[Good Source\]\(https:\/\/good\.example\/a\)/);
	assert.doesNotMatch(report, /bad\.example/);
	assert.match(report, /## Sources\n\n1\. \[Good Source\]/);
});

test("a duplicate decision falls back to the next unused plan step", async () => {
	const run = makeRun("q", {
		plan: {
			title: "P",
			steps: [
				{ title: "One", query: "first query" },
				{ title: "Two", query: "second query" },
			],
		},
	});
	const { tools, searched } = fakeTools({
		"first query": [{ title: "A", url: "https://a.example/1", content: "x" }],
		"second query": [{ title: "B", url: "https://b.example/2", content: "y" }],
	});
	const { call } = scriptedCaller({
		decisions: [
			'{"action":"search","title":"One","query":"first query"}',
			// Repeats itself: the loop must not spend the iteration on it.
			'{"action":"search","title":"One again","query":"first query"}',
			'{"action":"finish","title":"done"}',
		],
	});

	await executeRun(run, options(call, { tools }));

	assert.deepEqual(searched, ["first query", "second query"]);
});

test("unparseable decisions fall back to plan seeds, then end the loop", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools, searched } = fakeTools({
		"only query": [{ title: "A", url: "https://a.example/1", content: "x" }],
	});
	const { call } = scriptedCaller({
		decisions: ["I'm sorry, I can't do that", "still not json", "nope"],
	});

	await executeRun(run, options(call, { tools }));

	assert.deepEqual(searched, ["only query"]);
	assert.equal(run.steps.length, 1);
});

test("finishing before any evidence is refused", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools, searched } = fakeTools({
		"only query": [{ title: "A", url: "https://a.example/1", content: "x" }],
	});
	const { call } = scriptedCaller({
		decisions: ['{"action":"finish","title":"giving up"}', '{"action":"finish","title":"done"}'],
	});

	await executeRun(run, options(call, { tools }));

	assert.deepEqual(searched, ["only query"]);
});

test("a run that gathers nothing fails instead of writing an evidence-free report", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools } = fakeTools({});
	const { call } = scriptedCaller({ decisions: ['{"action":"search","title":"One","query":"only query"}'] });

	await assert.rejects(
		() => executeRun(run, options(call, { tools })),
		/No research step gathered any evidence/,
	);
});

test("a report with no marker triggers one recovery pass", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools } = fakeTools({
		"only query": [{ title: "A", url: "https://a.example/1", content: "x" }],
	});
	const { call, calls } = scriptedCaller({
		decisions: ['{"action":"search","title":"One","query":"only query"}', '{"action":"finish","title":"d"}'],
		report: ["Here are my thoughts, with no marker at all.", `${REPORT_MARKER}\nRecovered body.`],
	});

	const report = await executeRun(run, options(call, { tools }));

	assert.equal(calls.filter((c) => c === "report").length, 2);
	assert.match(report, /Recovered body\./);
});

test("a thinking model that answers only in its thinking block still works", async () => {
	// The failure this pins: Qwen3.8 at medium thinking reasoned its way to the
	// plan and stopped, leaving the content empty and the JSON in the thinking
	// block. Reading only the text parts turned that into
	// "No JSON object found in model reply" before a single search ran.
	const run = makeRun("q");
	const { call } = scriptedCaller({
		plan: '{"title":"T","steps":[{"title":"S","query":"a query"}]}',
		asThinking: true,
	});

	await planRun(run, options(call));

	assert.equal(run.status, "awaiting_approval");
	assert.equal(run.plan?.steps[0]?.query, "a query");
});

test("a whole run survives a model that never fills the content part", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools } = fakeTools({
		"only query": [{ title: "A", url: "https://a.example/1", content: "x" }],
	});
	const { call } = scriptedCaller({
		decisions: ['{"action":"search","title":"One","query":"only query"}', '{"action":"finish","title":"d"}'],
		audit: '{"thesis":"t","outline":["A"],"supportedClaims":[]}',
		report: [`${REPORT_MARKER}\n## Finding\n\nIt holds [A](https://a.example/1).`],
		asThinking: true,
	});

	const report = await executeRun(run, options(call, { tools }));

	assert.equal(run.status, "completed");
	assert.match(report, /\[A\]\(https:\/\/a\.example\/1\)/);
});

test("the JSON phases ask for less thinking; the report does not", async () => {
	const run = makeRun("q", {
		plan: { title: "P", steps: [{ title: "One", query: "only query" }] },
	});
	const { tools } = fakeTools({
		"only query": [{ title: "A", url: "https://a.example/1", content: "x" }],
	});
	const scripted = scriptedCaller({
		decisions: ['{"action":"search","title":"One","query":"only query"}', '{"action":"finish","title":"d"}'],
	});

	await executeRun(run, options(scripted.call, { tools }));

	// Two decisions and one audit ask for JSON; the report call must not, or the
	// model loses the reasoning the report is actually worth having.
	assert.equal(scripted.jsonCalls, 3);
	assert.equal(scripted.calls.filter((c) => c === "report").length, 1);
});

test("one broad search cannot spend the whole run's source budget", async () => {
	// What a real run showed: SearXNG returns dozens of hits, the first search
	// took all 40 slots, and every later step had nowhere to put its sources.
	const run = makeRun("q", {
		plan: {
			title: "P",
			steps: [
				{ title: "One", query: "first query" },
				{ title: "Two", query: "second query" },
			],
		},
		budgets: { maxSteps: 4, maxSources: 10, maxSourcesPerStep: 3, maxScrapePerStep: 0, toolTimeoutMs: 5_000 },
	});
	const many = (prefix: string) =>
		Array.from({ length: 20 }, (_, i) => ({
			title: `${prefix} ${i}`,
			url: `https://${prefix}.example/${i}`,
			content: "x",
		}));
	const { tools } = fakeTools({ "first query": many("a"), "second query": many("b") });
	const { call } = scriptedCaller({
		decisions: [
			'{"action":"search","title":"One","query":"first query"}',
			'{"action":"search","title":"Two","query":"second query"}',
			'{"action":"finish","title":"done"}',
		],
	});

	await executeRun(run, options(call, { tools }));

	assert.equal(run.sources.length, 6);
	assert.equal(run.sources.filter((s) => s.url.startsWith("https://a.")).length, 3);
	assert.equal(run.sources.filter((s) => s.url.startsWith("https://b.")).length, 3);
});
