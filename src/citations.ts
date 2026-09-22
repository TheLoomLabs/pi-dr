import type { Source } from "./types.ts";

/** Deterministic post-processing of the report. The model is asked to cite only the catalog;
 *  this is what makes it true. A report that padded itself with invented citations comes out
 *  of here shorter, which is why draft ranking compares post-validation length. */

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SOURCES_HEADING = /^#{1,6}\s*(sources|references|citations|bibliography|works cited)\s*:?\s*$/i;

interface Masked {
	text: string;
	restore: Map<string, string>;
}

/** Replace code spans and fenced blocks with sentinels so link rewriting cannot reach inside
 *  them. A report about HTTP APIs is full of URLs that are examples, not citations. */
function maskCode(input: string): Masked {
	const restore = new Map<string, string>();
	let counter = 0;
	const token = () => {
		const key = `\u0000code-${counter++}\u0000`;
		return key;
	};

	const lines = input.split("\n");
	const output: string[] = [];
	let fence: string | null = null;
	let buffer: string[] = [];

	for (const line of lines) {
		const match = line.match(CODE_FENCE);
		if (fence === null && match) {
			fence = match[1];
			buffer = [line];
			continue;
		}
		if (fence !== null) {
			buffer.push(line);
			if (line.trimStart().startsWith(fence)) {
				const key = token();
				restore.set(key, buffer.join("\n"));
				output.push(key);
				fence = null;
				buffer = [];
			}
			continue;
		}
		// Inline code, masked per line so a stray backtick cannot swallow the document.
		output.push(
			line.replace(/(`+)([^`]|[^`][\s\S]*?)\1/g, (span) => {
				const key = token();
				restore.set(key, span);
				return key;
			}),
		);
	}
	if (fence !== null) {
		// Unterminated fence: keep what the model wrote rather than dropping the tail.
		const key = token();
		restore.set(key, buffer.join("\n"));
		output.push(key);
	}

	return { text: output.join("\n"), restore };
}

function unmask(text: string, restore: Map<string, string>): string {
	return text.replace(/\u0000code-\d+\u0000/g, (key) => restore.get(key) ?? key);
}

/** Strip a trailing Sources/References section the model wrote itself. Only trailing: a
 *  mid-document heading with that name is a real section about sources. */
function dropModelSourceList(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		if (SOURCES_HEADING.test(line)) {
			const rest = lines.slice(i + 1).join("\n");
			// Only cut when what follows is a list or link soup, not prose.
			const isList = rest
				.split("\n")
				.filter((l) => l.trim())
				.every((l) => /^\s*(?:[-*+]|\d+[.)])\s|^\s*\[/.test(l));
			if (isList) return lines.slice(0, i).join("\n").trimEnd();
			return text;
		}
		// Stop at the first non-blank line that is not itself part of a list.
		if (!/^\s*(?:[-*+]|\d+[.)])\s|^\s*\[/.test(lines[i])) break;
	}
	return text;
}

export function validateReport(report: string, sources: Source[]): string {
	if (!report.trim()) return "";

	const byUrl = new Map(sources.map((source) => [source.url, source]));
	const masked = maskCode(report);
	let text = masked.text;

	// Markdown links: keep the ones that cite the catalog, canonicalize their title, and
	// unlink the rest down to their label text.
	text = text.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g, (match, label: string, url: string) => {
		const clean = url.replace(/[.,;:]+$/, "");
		const source = byUrl.get(clean);
		if (!source) return label || "";
		return `[${source.title.replace(/[[\]]/g, "")}](${clean})`;
	});

	// Autolinks and bare URLs: promoted to a real citation when they name a gathered source,
	// otherwise left as plain text so nothing links somewhere unvetted.
	text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_match, url: string) => {
		const source = byUrl.get(url);
		return source ? `[${source.title.replace(/[[\]]/g, "")}](${url})` : url;
	});
	text = text.replace(/(^|[^(\]])\b(https?:\/\/[^\s)<>\]]+)/g, (match, prefix: string, url: string) => {
		const clean = url.replace(/[.,;:]+$/, "");
		const source = byUrl.get(clean);
		if (!source) return match;
		const tail = url.slice(clean.length);
		return `${prefix}[${source.title.replace(/[[\]]/g, "")}](${clean})${tail}`;
	});

	// Numeric citations have no mapping we can trust, and a reader cannot resolve them either.
	text = text.replace(/(?<!\^)\[(\d{1,3})\](?!\()/g, "");

	text = dropModelSourceList(text);
	text = unmask(text, masked.restore);
	text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");

	return text.trim();
}

/** The source list is generated, never written by the model, so it always matches what was
 *  actually fetched. */
export function renderSourceList(sources: Source[]): string {
	if (sources.length === 0) return "";
	const lines = sources.map(
		(source, index) => `${index + 1}. [${source.title.replace(/[[\]]/g, "")}](${source.url})`,
	);
	return `\n\n## Sources\n\n${lines.join("\n")}\n`;
}
