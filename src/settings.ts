import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Every tunable, and where its current value came from.
 *
 * Three layers, highest first: the **environment**, for a one-off run that
 * should leave no trace; the **settings file**, for what you chose in the UI;
 * and the **defaults**. The layer that won is carried alongside the value,
 * because a settings screen that lets you edit a field an environment variable
 * is already overriding is a screen that lies to you.
 */

export type Source = "env" | "file" | "default";

export interface Tunables {
	searxngUrl: string;
	searxngAuth: string;
	categories: string;
	language: string;
	safesearch: 0 | 1 | 2;
	allowedDomains: string[];
	blockedDomains: string[];
	maxSteps: number;
	maxSources: number;
	maxSourcesPerStep: number;
	maxScrapePerStep: number;
	toolTimeoutMs: number;
}

export type StoredSettings = Partial<Tunables>;

/** Which env var, if any, overrides each field. */
export const ENV_VARS: Record<keyof Tunables, string> = {
	searxngUrl: "PI_DR_SEARXNG_URL",
	searxngAuth: "PI_DR_SEARXNG_AUTH",
	categories: "PI_DR_CATEGORIES",
	language: "PI_DR_LANGUAGE",
	safesearch: "PI_DR_SAFESEARCH",
	allowedDomains: "PI_DR_ALLOWED_DOMAINS",
	blockedDomains: "PI_DR_BLOCKED_DOMAINS",
	maxSteps: "PI_DR_MAX_STEPS",
	maxSources: "PI_DR_MAX_SOURCES",
	maxSourcesPerStep: "PI_DR_SOURCES_PER_STEP",
	maxScrapePerStep: "PI_DR_SCRAPE_PER_STEP",
	toolTimeoutMs: "PI_DR_TOOL_TIMEOUT_MS",
};

/** The port a SearXNG we started listens on. Not 8888: that is Unsloth
 *  Studio's, and a coding agent is exactly the machine likely to run one.
 *  8080 is worse — everything takes 8080. */
export const DEFAULT_SEARXNG_PORT = 8890;

export function defaultSearxngUrl(): string {
	return `http://localhost:${DEFAULT_SEARXNG_PORT}`;
}

export const DEFAULTS: Tunables = {
	searxngUrl: defaultSearxngUrl(),
	searxngAuth: "",
	categories: "general",
	language: "en",
	safesearch: 0,
	allowedDomains: [],
	blockedDomains: [],
	maxSteps: 12,
	maxSources: 40,
	maxSourcesPerStep: 8,
	maxScrapePerStep: 2,
	toolTimeoutMs: 30_000,
};

/** Bounds, so neither a typed value nor a stale file can produce a run that
 *  cannot work. Applied on read as well as on write: the file is editable. */
export const LIMITS: Partial<Record<keyof Tunables, { min: number; max: number }>> = {
	safesearch: { min: 0, max: 2 },
	maxSteps: { min: 1, max: 30 },
	maxSources: { min: 1, max: 200 },
	maxSourcesPerStep: { min: 1, max: 50 },
	maxScrapePerStep: { min: 0, max: 5 },
	toolTimeoutMs: { min: 5_000, max: 300_000 },
};

export function settingsPath(): string {
	return join(getAgentDir(), "deep-research.json");
}

export function readSettings(): StoredSettings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as StoredSettings;
	} catch {
		// No file, unreadable, or not JSON: first run, which is not an error.
		return {};
	}
}

/** Merge and write. Returns what went wrong rather than throwing: a setting we
 *  could not save is worth a sentence, not a failed research run. */
export function writeSettings(update: StoredSettings): { ok: boolean; error?: string } {
	try {
		const path = settingsPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ ...readSettings(), ...update }, null, 2)}\n`, "utf8");
		return { ok: true };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

function clamp(key: keyof Tunables, value: number): number {
	const limit = LIMITS[key];
	if (!limit) return value;
	return Math.max(limit.min, Math.min(limit.max, value));
}

export function parseDomains(raw: string): string[] {
	return raw
		.split(",")
		.map((d) => d.trim().toLowerCase().replace(/^\.+/, ""))
		.filter(Boolean);
}

export interface Resolved<T> {
	value: T;
	source: Source;
}

/** Resolve one field across the three layers. */
function resolve<K extends keyof Tunables>(key: K, stored: StoredSettings): Resolved<Tunables[K]> {
	const env = process.env[ENV_VARS[key]];
	const fromFile = stored[key];
	const fallback = DEFAULTS[key];

	if (typeof fallback === "number") {
		if (env !== undefined && env !== "") {
			const parsed = Number.parseInt(env, 10);
			if (Number.isFinite(parsed)) {
				return { value: clamp(key, parsed) as Tunables[K], source: "env" };
			}
		}
		if (typeof fromFile === "number" && Number.isFinite(fromFile)) {
			return { value: clamp(key, fromFile) as Tunables[K], source: "file" };
		}
		return { value: fallback as Tunables[K], source: "default" };
	}

	if (Array.isArray(fallback)) {
		if (env !== undefined && env !== "") {
			return { value: parseDomains(env) as Tunables[K], source: "env" };
		}
		if (Array.isArray(fromFile)) {
			return { value: parseDomains(fromFile.join(",")) as Tunables[K], source: "file" };
		}
		return { value: [] as unknown as Tunables[K], source: "default" };
	}

	if (env !== undefined && env !== "") return { value: env as Tunables[K], source: "env" };
	if (typeof fromFile === "string" && fromFile !== "") {
		return { value: fromFile as Tunables[K], source: "file" };
	}
	return { value: fallback as Tunables[K], source: "default" };
}

export type ResolvedTunables = { [K in keyof Tunables]: Resolved<Tunables[K]> };

export function resolveSettings(stored: StoredSettings = readSettings()): ResolvedTunables {
	const out = {} as ResolvedTunables;
	for (const key of Object.keys(DEFAULTS) as (keyof Tunables)[]) {
		// Each field is resolved on its own, so one value from the environment
		// does not drag the rest of the file along with it.
		(out[key] as Resolved<unknown>) = resolve(key, stored);
	}
	return out;
}

export function values(resolved: ResolvedTunables = resolveSettings()): Tunables {
	const out = {} as Tunables;
	for (const key of Object.keys(DEFAULTS) as (keyof Tunables)[]) {
		(out[key] as unknown) = resolved[key].value;
	}
	return out;
}
