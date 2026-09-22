import type { ActionKind, Audit, Plan, PlanStep, ResearchState } from "./types.ts";

/** Pull the first balanced JSON object out of a model reply. Small models fence their JSON,
 *  prepend an apology, or append a closing remark; all three still contain one usable object. */
export function parseJsonObject(text: string): Record<string, unknown> {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates = fenced ? [fenced[1], trimmed] : [trimmed];

	for (const candidate of candidates) {
		const start = candidate.indexOf("{");
		if (start === -1) continue;

		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = start; i < candidate.length; i++) {
			const char = candidate[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (char === "{") depth++;
			else if (char === "}") {
				depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(candidate.slice(start, i + 1));
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
							return parsed as Record<string, unknown>;
						}
					} catch {
						// Keep scanning: a truncated object may be followed by a complete one.
					}
					break;
				}
			}
		}
	}
	throw new Error("No JSON object found in model reply");
}

/** Inline thinking, for servers that put it in the content rather than in a
 *  thinking block. Unclosed too: a reply cut off mid-thought still has usable
 *  JSON before it, and never any after. */
const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi;

export function stripThinking(text: string): string {
	return text.replace(THINK_BLOCK, " ").trim();
}

/**
 * The JSON a model meant to send, wherever it actually put it.
 *
 * A thinking model reasons its way to the object and then, often enough, stops:
 * the answer is in the thinking block and the content is empty. A server that
 * inlines thinking puts prose and the object in the same string. Both are the
 * model doing as it was asked, so both are read — content first, because that
 * is where the deliberate answer goes when there is one.
 *
 * The error carries what was actually seen. "No JSON object found" on its own
 * is unactionable; the first line of the reply usually says exactly what went
 * wrong.
 */
export function parseJsonReply(text: string, reasoning = ""): Record<string, unknown> {
	for (const candidate of [stripThinking(text), text, reasoning]) {
		if (!candidate.trim()) continue;
		try {
			return parseJsonObject(candidate);
		} catch {
			// Try the next place the model may have left it.
		}
	}
	const seen = (text.trim() || reasoning.trim()).replace(/\s+/g, " ").slice(0, 200);
	throw new Error(
		seen
			? `The model did not return JSON. It said: "${seen}"`
			: "The model returned nothing at all. If it is a thinking model, its whole budget went to thinking \u2014 lower the thinking level and retry.",
	);
}

function text(value: unknown, max = 400): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringList(value: unknown, max = 8): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => text(item))
		.filter(Boolean)
		.slice(0, max);
}

export function validatePlan(value: Record<string, unknown>, maxSteps: number): Plan {
	const title = text(value.title, 200);
	const rawSteps = Array.isArray(value.steps) ? value.steps : [];
	const steps: PlanStep[] = [];
	const seen = new Set<string>();

	for (const raw of rawSteps) {
		if (!raw || typeof raw !== "object") continue;
		const step = raw as Record<string, unknown>;
		const query = text(step.query, 400);
		if (!query) continue;
		const key = query.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		steps.push({ title: text(step.title, 120) || query.slice(0, 60), query });
		if (steps.length >= maxSteps) break;
	}

	if (steps.length === 0) throw new Error("Plan contains no usable steps");
	return { title: title || steps[0].title, steps };
}

export function normalizeResearchState(value: unknown): ResearchState | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const state = value as Record<string, unknown>;
	const normalized: ResearchState = {
		summary: text(state.summary, 2000),
		gaps: stringList(state.gaps),
		unsupportedClaims: stringList(state.unsupportedClaims),
		nextBridge: text(state.nextBridge, 400),
	};
	const empty =
		!normalized.summary &&
		normalized.gaps.length === 0 &&
		normalized.unsupportedClaims.length === 0 &&
		!normalized.nextBridge;
	return empty ? null : normalized;
}

export interface DecisionAction {
	action: ActionKind;
	title: string;
	argument: string;
	researchState: ResearchState | null;
}

export function validateAction(
	value: Record<string, unknown>,
	knownUrls: Set<string>,
): DecisionAction {
	const action = text(value.action, 20).toLowerCase();
	const researchState = normalizeResearchState(value.researchState);

	if (action === "finish") {
		return { action: "finish", title: text(value.title, 120) || "Finishing", argument: "", researchState };
	}
	if (action === "search") {
		const query = text(value.query, 400);
		if (!query) throw new Error("search action has no query");
		return { action: "search", title: text(value.title, 120) || query.slice(0, 60), argument: query, researchState };
	}
	if (action === "fetch") {
		const url = text(value.url, 2000);
		// A URL the loop never gathered is either a hallucination or an injection trying to
		// steer the fetcher somewhere. Both are refused the same way.
		if (!knownUrls.has(url)) throw new Error("fetch action names a URL that was never gathered");
		return { action: "fetch", title: text(value.title, 120) || url.slice(0, 60), argument: url, researchState };
	}
	throw new Error(`Unknown action: ${action || "(none)"}`);
}

export function validateAudit(value: Record<string, unknown>, knownUrls: Set<string>): Audit {
	const claims = Array.isArray(value.supportedClaims) ? value.supportedClaims : [];
	return {
		thesis: text(value.thesis, 1000),
		outline: stringList(value.outline, 20),
		supportedClaims: claims
			.map((raw) => {
				if (!raw || typeof raw !== "object") return null;
				const entry = raw as Record<string, unknown>;
				const claim = text(entry.claim, 600);
				const urls = stringList(entry.sourceUrls, 6).filter((url) => knownUrls.has(url));
				return claim && urls.length > 0 ? { claim, sourceUrls: urls } : null;
			})
			.filter((claim): claim is { claim: string; sourceUrls: string[] } => claim !== null)
			.slice(0, 40),
		designInferences: stringList(value.designInferences, 12),
		unsupportedPrecision: stringList(value.unsupportedPrecision, 12),
		contradictions: stringList(value.contradictions, 12),
		missingDimensions: stringList(value.missingDimensions, 12),
	};
}

/** The plan doubles as the loop's fallback: when a decision is unusable, duplicated, or refused,
 *  the next unused plan query runs instead of wasting the iteration. */
export function nextUnusedSeed(
	plan: Plan,
	usedQueries: Set<string>,
): { title: string; query: string } | null {
	for (const step of plan.steps) {
		if (!usedQueries.has(step.query.toLowerCase())) return { title: step.title, query: step.query };
	}
	return null;
}

export function reportAfterMarker(text: string, marker: string): string {
	const index = text.lastIndexOf(marker);
	return index === -1 ? "" : text.slice(index + marker.length).trim();
}

/** Refuse a query that carries something private into a search engine. Cheap, blunt, and it
 *  only has to catch the obvious exfiltration shapes. */
const SECRET_PATTERNS = [
	/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9-_]{16,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
	/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
	/\b(?:\d[ -]*?){13,16}\b/,
];

export function sanitizeQuery(query: string): string {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("empty query");
	if (trimmed.length > 400) throw new Error("query is too long to be a public search term");
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(trimmed)) throw new Error("query looks like it carries private data");
	}
	return trimmed;
}
