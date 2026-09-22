import type { Config } from "./config.ts";
import { urlAllowed } from "./config.ts";

const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 20_000;

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	ldquo: "“",
	rdquo: "”",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/** Deliberately dependency-free. A readability port would extract better prose, but it is one
 *  more thing to audit in an extension that already handles untrusted HTML, and the decision
 *  model only needs enough text to judge a claim. */
export function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<(script|style|noscript|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, " ");
	text = text.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
	// Block-level tags become line breaks so headings and list items stay separable.
	text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");
	text = decodeEntities(text);
	text = text.replace(/[ \t ]+/g, " ");
	text = text.replace(/ ?\n ?/g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

export interface FetchedPage {
	url: string;
	title: string;
	text: string;
}

export async function fetchPage(
	config: Config,
	url: string,
	signal: AbortSignal,
): Promise<FetchedPage> {
	if (!urlAllowed(url, config.websitePolicy)) {
		throw new Error(`Blocked by website policy: ${url}`);
	}

	const response = await fetch(url, {
		redirect: "follow",
		signal,
		headers: {
			// Some sites serve a consent wall to unknown agents; a plain desktop UA gets the article.
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
		},
	});

	if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

	// A redirect can land somewhere the policy forbids, so the final URL is checked too.
	if (!urlAllowed(response.url || url, config.websitePolicy)) {
		throw new Error(`Redirected outside the website policy: ${response.url}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (!/text\/html|text\/plain|application\/xhtml|application\/json/i.test(contentType)) {
		throw new Error(`Unsupported content type (${contentType || "unknown"}) at ${url}`);
	}

	const buffer = await response.arrayBuffer();
	const raw = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, MAX_BYTES));
	const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : url;
	const text = /html|xhtml/i.test(contentType) ? htmlToText(raw) : raw;

	if (!text.trim()) throw new Error(`No readable text at ${url}`);

	return { url: response.url || url, title: title || url, text: text.slice(0, MAX_TEXT_CHARS) };
}
