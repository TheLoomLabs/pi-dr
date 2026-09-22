import { DEFAULT_SEARXNG_PORT, defaultSearxngUrl, values, type Tunables } from "./settings.ts";
import type { Budgets, WebsitePolicy } from "./types.ts";

export { DEFAULT_SEARXNG_PORT, defaultSearxngUrl };

/**
 * One run's view of the settings.
 *
 * A flat snapshot taken once per run rather than read per call: a research run
 * spans minutes, and a setting changed halfway through must not apply to half
 * of it.
 */
export interface Config {
	searxngUrl: string;
	searxngAuth?: string;
	language: string;
	safesearch: 0 | 1 | 2;
	/** SearXNG category list, comma separated. `general` alone is usually right;
	 *  add `science` for paper-heavy topics. */
	categories: string;
	budgets: Budgets;
	websitePolicy: WebsitePolicy;
}

export function configFrom(tunables: Tunables): Config {
	return {
		searxngUrl: tunables.searxngUrl.replace(/\/+$/, ""),
		...(tunables.searxngAuth ? { searxngAuth: tunables.searxngAuth } : {}),
		language: tunables.language,
		safesearch: tunables.safesearch,
		categories: tunables.categories,
		budgets: {
			maxSteps: tunables.maxSteps,
			maxSources: tunables.maxSources,
			maxSourcesPerStep: tunables.maxSourcesPerStep,
			maxScrapePerStep: tunables.maxScrapePerStep,
			toolTimeoutMs: tunables.toolTimeoutMs,
		},
		websitePolicy: {
			allowedDomains: tunables.allowedDomains,
			blockedDomains: tunables.blockedDomains,
		},
	};
}

export function loadConfig(): Config {
	return configFrom(values());
}

/** Host-suffix match, so `example.com` covers `docs.example.com` but not `notexample.com`.
 *  An allow list, when present, is exclusive: nothing outside it is reachable. */
export function urlAllowed(rawUrl: string, policy: WebsitePolicy): boolean {
	let host: string;
	try {
		const url = new URL(rawUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		host = url.hostname.toLowerCase();
	} catch {
		return false;
	}
	const matches = (d: string) => host === d || host.endsWith(`.${d}`);
	if (policy.blockedDomains.some(matches)) return false;
	if (policy.allowedDomains.length > 0) return policy.allowedDomains.some(matches);
	return true;
}

export function policyPrompt(policy: WebsitePolicy): string {
	const lines: string[] = [];
	if (policy.allowedDomains.length > 0) {
		lines.push(
			`Only these domains may be used as sources: ${policy.allowedDomains.join(", ")}. ` +
				"Shape queries so they surface results on those domains.",
		);
	}
	if (policy.blockedDomains.length > 0) {
		lines.push(`Never use these domains as sources: ${policy.blockedDomains.join(", ")}.`);
	}
	return lines.join("\n");
}
