import assert from "node:assert/strict";
import { test } from "node:test";
import { urlAllowed } from "../src/config.ts";
import { htmlToText } from "../src/fetcher.ts";
import {
	nextUnusedSeed,
	parseJsonObject,
	parseJsonReply,
	reportAfterMarker,
	sanitizeQuery,
	stripThinking,
	validateAction,
	validateAudit,
	validatePlan,
} from "../src/parsing.ts";
import { renderSourceList, validateReport } from "../src/citations.ts";
import { canApprove, hashPlan } from "../src/store.ts";
import type { Source } from "../src/types.ts";

const source = (url: string, title: string): Source => ({
	url,
	title,
	snippet: "",
	stepPosition: 0,
	fetchedAt: 0,
});

test("parseJsonObject survives fences, preambles and trailing prose", () => {
	assert.equal(parseJsonObject('{"a":1}').a, 1);
	assert.equal(parseJsonObject('```json\n{"a":2}\n```').a, 2);
	assert.equal(parseJsonObject('Sure! {"a":3} Let me know.').a, 3);
	assert.equal(parseJsonObject('{"a":"}not the end"}').a, "}not the end");
	assert.throws(() => parseJsonObject("no json here"));
});

test("validatePlan drops duplicate and query-less steps, and caps length", () => {
	const plan = validatePlan(
		{
			title: "T",
			steps: [
				{ title: "a", query: "one" },
				{ title: "b", query: "ONE" },
				{ title: "c" },
				{ title: "d", query: "two" },
				{ title: "e", query: "three" },
			],
		},
		2,
	);
	assert.equal(plan.steps.length, 2);
	assert.deepEqual(
		plan.steps.map((s) => s.query),
		["one", "two"],
	);
	assert.throws(() => validatePlan({ title: "T", steps: [] }, 5));
});

test("validateAction refuses a fetch URL that was never gathered", () => {
	const known = new Set(["https://a.example/doc"]);
	assert.equal(
		validateAction({ action: "fetch", title: "x", url: "https://a.example/doc" }, known).argument,
		"https://a.example/doc",
	);
	assert.throws(() =>
		validateAction({ action: "fetch", title: "x", url: "https://evil.example/x" }, known),
	);
});

test("validateAudit keeps only claims backed by a catalog URL", () => {
	const audit = validateAudit(
		{
			thesis: "t",
			outline: ["one"],
			supportedClaims: [
				{ claim: "real", sourceUrls: ["https://a.example/doc"] },
				{ claim: "invented", sourceUrls: ["https://nope.example"] },
				{ claim: "unsourced", sourceUrls: [] },
			],
		},
		new Set(["https://a.example/doc"]),
	);
	assert.equal(audit.supportedClaims.length, 1);
	assert.equal(audit.supportedClaims[0].claim, "real");
});

test("sanitizeQuery rejects queries carrying private data", () => {
	assert.equal(sanitizeQuery("  rust async runtime benchmark  "), "rust async runtime benchmark");
	assert.throws(() => sanitizeQuery("deploy key sk-abcdefghijklmnopqrstuvwx"));
	assert.throws(() => sanitizeQuery("contact someone@example.com about it"));
	assert.throws(() => sanitizeQuery(""));
});

test("nextUnusedSeed walks the plan in order", () => {
	const plan = { title: "T", steps: [{ title: "a", query: "one" }, { title: "b", query: "two" }] };
	assert.equal(nextUnusedSeed(plan, new Set())!.query, "one");
	assert.equal(nextUnusedSeed(plan, new Set(["one"]))!.query, "two");
	assert.equal(nextUnusedSeed(plan, new Set(["one", "two"])), null);
});

test("validateReport keeps catalog citations and unlinks everything else", () => {
	const sources = [source("https://a.example/doc", "Real Doc")];
	const out = validateReport(
		"Claim one [Some Label](https://a.example/doc).\nClaim two [Fake](https://evil.example/x).",
		sources,
	);
	assert.match(out, /\[Real Doc\]\(https:\/\/a\.example\/doc\)/);
	assert.doesNotMatch(out, /evil\.example/);
	assert.match(out, /Claim two Fake\./);
});

test("validateReport does not rewrite URLs inside code", () => {
	const sources = [source("https://a.example/doc", "Real Doc")];
	const out = validateReport(
		"Text.\n\n```bash\ncurl https://a.example/doc\n```\n\nAnd `https://a.example/doc` inline.",
		sources,
	);
	assert.match(out, /curl https:\/\/a\.example\/doc/);
	assert.match(out, /`https:\/\/a\.example\/doc`/);
});

test("validateReport promotes a bare catalog URL and drops numeric citations", () => {
	const sources = [source("https://a.example/doc", "Real Doc")];
	const out = validateReport("See https://a.example/doc for detail [1].", sources);
	assert.match(out, /\[Real Doc\]\(https:\/\/a\.example\/doc\)/);
	assert.doesNotMatch(out, /\[1\]/);
});

test("validateReport strips a model-authored trailing source list", () => {
	const sources = [source("https://a.example/doc", "Real Doc")];
	const out = validateReport(
		"Body text.\n\n## Sources\n\n- [Real Doc](https://a.example/doc)\n- [Ghost](https://ghost.example)",
		sources,
	);
	assert.doesNotMatch(out, /## Sources/);
	assert.match(out, /Body text\./);
});

test("renderSourceList is generated from what was fetched", () => {
	const list = renderSourceList([source("https://a.example/doc", "Real Doc")]);
	assert.match(list, /## Sources/);
	assert.match(list, /1\. \[Real Doc\]\(https:\/\/a\.example\/doc\)/);
});

test("urlAllowed matches host suffixes, and an allow list is exclusive", () => {
	assert.equal(urlAllowed("https://docs.example.com/x", { allowedDomains: [], blockedDomains: [] }), true);
	assert.equal(
		urlAllowed("https://docs.example.com/x", { allowedDomains: ["example.com"], blockedDomains: [] }),
		true,
	);
	assert.equal(
		urlAllowed("https://notexample.com/x", { allowedDomains: ["example.com"], blockedDomains: [] }),
		false,
	);
	assert.equal(
		urlAllowed("https://ads.example.com/x", { allowedDomains: [], blockedDomains: ["ads.example.com"] }),
		false,
	);
	assert.equal(urlAllowed("file:///etc/passwd", { allowedDomains: [], blockedDomains: [] }), false);
});

test("plan hash gates approval on the exact plan that was reviewed", () => {
	const plan = { title: "T", steps: [{ title: "a", query: "one" }] };
	const run = { planRevision: 1, planHash: hashPlan(plan) } as never as Parameters<typeof canApprove>[0];
	assert.equal(canApprove(run, 1, hashPlan(plan)), true);
	assert.equal(canApprove(run, 1, hashPlan({ title: "T", steps: [{ title: "a", query: "two" }] })), false);
	assert.equal(canApprove(run, 2, hashPlan(plan)), false);
});

test("htmlToText drops scripts and chrome, keeps prose", () => {
	const text = htmlToText(
		"<html><head><title>T</title><script>var x = 1;</script></head>" +
			"<body><nav>menu menu</nav><p>First &amp; best.</p><p>Second.</p></body></html>",
	);
	assert.match(text, /First & best\./);
	assert.match(text, /Second\./);
	assert.doesNotMatch(text, /var x/);
	assert.doesNotMatch(text, /menu menu/);
});

test("reportAfterMarker takes the last marker", () => {
	assert.equal(reportAfterMarker("notes\nMARK\nreal report", "MARK"), "real report");
	assert.equal(reportAfterMarker("no marker here", "MARK"), "");
});

test("parseJsonReply finds the object wherever the model left it", () => {
	assert.equal(parseJsonReply('{"a":1}', "").a, 1);
	// Content empty, answer in the thinking block.
	assert.equal(parseJsonReply("", '{"a":2}').a, 2);
	// Thinking inlined in the content, with the real answer after it.
	assert.equal(parseJsonReply('<think>let me see...</think>\n{"a":3}', "").a, 3);
	// An unclosed think tag: cut off mid-thought, but the content is still there.
	assert.equal(parseJsonReply('{"a":4}\n<think>hmm', "").a, 4);
	// Content wins over thinking when both parse: it is the deliberate answer.
	assert.equal(parseJsonReply('{"a":5}', '{"a":6}').a, 5);
});

test("a reply with no JSON says what the model actually said", () => {
	assert.throws(
		() => parseJsonReply("I cannot help with that request.", ""),
		/It said: "I cannot help with that request\."/,
	);
	assert.throws(() => parseJsonReply("", ""), /returned nothing at all/);
});

test("stripThinking removes the block, not the answer", () => {
	assert.equal(stripThinking("<thinking>a</thinking> b"), "b");
	assert.equal(stripThinking("<reasoning>a</reasoning>b"), "b");
	assert.equal(stripThinking("plain"), "plain");
});
