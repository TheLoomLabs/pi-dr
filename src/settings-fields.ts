import { DEFAULTS, LIMITS, parseDomains, type Tunables } from "./settings.ts";

/**
 * The settings screen's contents, as data.
 *
 * A description rather than a rendering: the card walks this list, so adding a
 * tunable is one entry here and nothing in the UI — and every rule about what a
 * field accepts is a pure function a test can drive, rather than something you
 * discover by typing into a modal.
 */

export type FieldKind = "text" | "secret" | "number" | "choice" | "domains";

export interface Field {
	key: keyof Tunables;
	group: string;
	label: string;
	kind: FieldKind;
	help: string;
	/** `number` only: what one press of ← or → is worth. */
	step?: number;
	/** `choice` only, in order. */
	choices?: { value: number; label: string }[];
	/** `number` only: how the value reads, when it is not just a number. */
	unit?: (value: number) => string;
}

export const FIELDS: Field[] = [
	{
		key: "searxngUrl",
		group: "Search",
		label: "SearXNG URL",
		kind: "text",
		help: "Which instance to query. Changing this away from the default means the start/stop control is no longer yours.",
	},
	{
		key: "searxngAuth",
		group: "Search",
		label: "Authorization header",
		kind: "secret",
		help: "Sent as the Authorization header, for an instance behind auth. Blank for none.",
	},
	{
		key: "categories",
		group: "Search",
		label: "Categories",
		kind: "text",
		help: "SearXNG categories, comma separated. Add `science` for paper-heavy topics.",
	},
	{
		key: "language",
		group: "Search",
		label: "Language",
		kind: "text",
		help: "Result language, as SearXNG spells it: en, de, hr, all.",
	},
	{
		key: "safesearch",
		group: "Search",
		label: "Safe search",
		kind: "choice",
		help: "Engine support varies; some ignore it entirely.",
		choices: [
			{ value: 0, label: "off" },
			{ value: 1, label: "moderate" },
			{ value: 2, label: "strict" },
		],
	},
	{
		key: "allowedDomains",
		group: "Sources",
		label: "Allowed domains",
		kind: "domains",
		help: "When set, nothing outside this list can be cited. Enforced in the prompts and in code, including after redirects.",
	},
	{
		key: "blockedDomains",
		group: "Sources",
		label: "Blocked domains",
		kind: "domains",
		help: "Never used as a source. Host suffixes: example.com also covers docs.example.com.",
	},
	{
		key: "maxSourcesPerStep",
		group: "Sources",
		label: "Sources per search",
		kind: "number",
		step: 1,
		help: "Caps what one broad query can contribute, so the first search cannot spend the whole run.",
	},
	{
		key: "maxSources",
		group: "Sources",
		label: "Sources per run",
		kind: "number",
		step: 5,
		help: "The total source catalog a report may cite from.",
	},
	{
		key: "maxScrapePerStep",
		group: "Sources",
		label: "Pages read per search",
		kind: "number",
		step: 1,
		help: "Top results fetched in full. 0 is snippets only: faster, and much weaker on technical claims.",
	},
	{
		key: "maxSteps",
		group: "Run",
		label: "Actions per run",
		kind: "number",
		step: 1,
		help: "Searches and fetches the loop may make before it must write the report.",
	},
	{
		key: "toolTimeoutMs",
		group: "Run",
		label: "Search timeout",
		kind: "number",
		step: 5_000,
		unit: (value) => `${Math.round(value / 1000)}s`,
		help: "Budget for one search or one page fetch.",
	},
];

/** How a value reads on the screen. Never blank: an empty row looks broken,
 *  and "any"/"none" is the actual meaning of an empty list. */
export function format(field: Field, value: unknown): string {
	if (field.kind === "choice") {
		return field.choices?.find((choice) => choice.value === value)?.label ?? String(value);
	}
	if (field.kind === "domains") {
		const list = Array.isArray(value) ? value : [];
		if (list.length > 0) return list.join(", ");
		return field.key === "allowedDomains" ? "any" : "none";
	}
	if (field.kind === "secret") {
		const text = String(value ?? "");
		// Shown as a length, never as characters: a settings screen is the one
		// place a shoulder or a screenshot reliably catches a credential.
		return text ? `set (${text.length} characters)` : "none";
	}
	if (field.kind === "number") {
		const number = Number(value);
		return field.unit ? field.unit(number) : String(number);
	}
	return String(value ?? "") || "(unset)";
}

/** The editable text for a field, for when editing starts. */
export function editable(field: Field, value: unknown): string {
	if (field.kind === "domains") return Array.isArray(value) ? value.join(", ") : "";
	if (field.kind === "secret") return "";
	return String(value ?? "");
}

function clamp(key: keyof Tunables, value: number): number {
	const limit = LIMITS[key];
	if (!limit) return value;
	return Math.max(limit.min, Math.min(limit.max, value));
}

/** ← and → on a number or a choice. Choices wrap; numbers stop at their bounds. */
export function adjust(field: Field, value: unknown, delta: number): unknown {
	if (field.kind === "choice" && field.choices) {
		const at = field.choices.findIndex((choice) => choice.value === value);
		const next = (at + delta + field.choices.length) % field.choices.length;
		return field.choices[next]?.value ?? value;
	}
	if (field.kind === "number") {
		return clamp(field.key, Number(value) + delta * (field.step ?? 1));
	}
	return value;
}

export interface ParseResult {
	value?: unknown;
	error?: string;
}

/** What a typed value becomes, or why it is refused. */
export function parse(field: Field, raw: string): ParseResult {
	const text = raw.trim();

	if (field.kind === "domains") return { value: parseDomains(text) };
	if (field.kind === "secret") return { value: text };

	if (field.kind === "number") {
		const parsed = Number.parseInt(text, 10);
		if (!Number.isFinite(parsed)) return { error: "That is not a number." };
		const limit = LIMITS[field.key];
		if (limit && (parsed < limit.min || parsed > limit.max)) {
			return { error: `Must be between ${limit.min} and ${limit.max}.` };
		}
		return { value: parsed };
	}

	if (field.key === "searxngUrl") {
		if (!/^https?:\/\/[^\s]+$/i.test(text)) return { error: "That is not an http(s) URL." };
		return { value: text.replace(/\/+$/, "") };
	}

	if (field.key === "language" && text && !/^[a-z]{2}(-[a-z]{2})?$|^all$/i.test(text)) {
		return { error: "Use a language code such as en, hr, en-GB, or all." };
	}

	if (field.key === "categories" && !text) return { error: "At least one category is needed." };

	return { value: text };
}

export function defaultFor(field: Field): unknown {
	return DEFAULTS[field.key];
}
