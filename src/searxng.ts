import type { Config } from "./config.ts";
import { urlAllowed } from "./config.ts";
import type { SearchHit } from "./types.ts";

interface SearxngResult {
	url?: unknown;
	title?: unknown;
	content?: unknown;
	engine?: unknown;
	publishedDate?: unknown;
}

interface SearxngResponse {
	results?: SearxngResult[];
	number_of_results?: number;
	unresponsive_engines?: unknown[];
}

export class SearchError extends Error {}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** POST rather than GET: queries routinely exceed what proxies are happy to log, and SearXNG
 *  accepts form-encoded search params on the same endpoint. */
export async function searxngSearch(
	config: Config,
	query: string,
	signal: AbortSignal,
): Promise<SearchHit[]> {
	const body = new URLSearchParams({
		q: query,
		format: "json",
		categories: config.categories,
		language: config.language,
		safesearch: String(config.safesearch),
		pageno: "1",
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	if (config.searxngAuth) headers.Authorization = config.searxngAuth;

	let response: Response;
	try {
		response = await fetch(`${config.searxngUrl}/search`, {
			method: "POST",
			headers,
			body,
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		throw new SearchError(
			`Cannot reach SearXNG at ${config.searxngUrl}: ${(error as Error).message}. ` +
				"Set PI_DR_SEARXNG_URL, or start your instance.",
		);
	}

	if (response.status === 403) {
		throw new SearchError(
			"SearXNG refused the JSON API (403). Add `json` to `search.formats` in settings.yml " +
				"and restart the instance.",
		);
	}
	if (!response.ok) {
		throw new SearchError(`SearXNG returned HTTP ${response.status}`);
	}

	let payload: SearxngResponse;
	try {
		payload = (await response.json()) as SearxngResponse;
	} catch {
		throw new SearchError(
			"SearXNG did not return JSON. The instance is probably serving HTML only; " +
				"enable the json format in settings.yml.",
		);
	}

	const seen = new Set<string>();
	const hits: SearchHit[] = [];
	for (const result of payload.results ?? []) {
		const url = str(result.url);
		if (!url || seen.has(url)) continue;
		// Policy is enforced here as well as in the prompt: the model is advice, this is the gate.
		if (!urlAllowed(url, config.websitePolicy)) continue;
		seen.add(url);
		hits.push({
			url,
			title: str(result.title) || url,
			content: str(result.content).slice(0, 1200),
			engine: str(result.engine) || undefined,
			publishedDate: str(result.publishedDate) || undefined,
		});
	}
	return hits;
}

/** Render hits the way the decision model reads them. Kept stable because the model learns
 *  this shape across turns. */
export function formatHits(hits: SearchHit[]): string {
	if (hits.length === 0) return "(no results)";
	return hits
		.map((hit) => {
			const date = hit.publishedDate ? `\nDate: ${hit.publishedDate}` : "";
			return `Title: ${hit.title}\nURL: ${hit.url}${date}\nSnippet: ${hit.content}`;
		})
		.join("\n\n---\n\n");
}

export interface Probe {
	ok: boolean;
	/** One sentence, already phrased for a person to read. */
	detail: string;
	/** The instance answered, but not with JSON — a config fix, not a missing server. */
	needsJson: boolean;
}

/**
 * Is there a usable instance at this URL?
 *
 * "Usable" is narrower than "reachable": an instance serving only HTML is up,
 * answers, and is no good to us, and telling those two apart is the difference
 * between "start one" and "add two lines to settings.yml".
 */
export async function probeSearxng(config: Config, signal: AbortSignal): Promise<Probe> {
	try {
		await searxngSearch(config, "pi deep research connectivity probe", signal);
		return { ok: true, detail: `SearXNG is answering at ${config.searxngUrl}.`, needsJson: false };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const needsJson = error instanceof SearchError && /json|403/i.test(message);
		return { ok: false, detail: message, needsJson };
	}
}

/**
 * Wait for an instance that is starting.
 *
 * A fresh container answers its port before it can search — the engines load
 * after the listener binds — so this polls the real thing rather than the
 * socket, and keeps going through failures until the deadline.
 */
export async function waitForSearxng(
	config: Config,
	signal: AbortSignal,
	timeoutMs = 90_000,
): Promise<Probe> {
	const deadline = Date.now() + timeoutMs;
	let last: Probe = { ok: false, detail: "never answered", needsJson: false };
	while (Date.now() < deadline && !signal.aborted) {
		// Per attempt, so one instance that accepts the connection and then says
		// nothing cannot eat the whole budget in a single try.
		last = await probeSearxng(config, AbortSignal.any([signal, AbortSignal.timeout(8_000)]));
		if (last.ok) return last;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	return last;
}
