import { Key, matchesKey } from "@earendil-works/pi-tui";
import { clip, elide, FRAME_CHROME, frame, hints, pad, strong, wrap, type FrameTheme } from "./frame.ts";
import { field, handleFieldKey, withCursor, type Field } from "./field.ts";

export type SetupChoice = { kind: "docker" } | { kind: "url"; url: string } | { kind: "cancel" };

interface Option {
	value: "docker" | "url" | "cancel";
	label: string;
	description: string;
	enabled: boolean;
}

type Mode = "menu" | "url" | "working";

/**
 * What happens when there is no SearXNG to talk to.
 *
 * The card exists because the alternative is worse in both directions: failing
 * with "connection refused" tells someone who has never run SearXNG nothing at
 * all, and quietly starting a container for them is a change to their machine
 * they did not ask for. So it says what is missing, offers the two fixes, and
 * does neither until a key is pressed.
 */
export class SetupCard {
	private readonly theme: FrameTheme;
	private readonly url: string;
	private readonly reason: string;
	private readonly needsJson: boolean;
	private options: Option[];
	private selected = 0;
	private mode: Mode = "menu";
	private buffer: Field = field("");
	private message = "";
	private progress: string[] = [];

	public onDone?: (choice: SetupChoice | null) => void;

	constructor(options: {
		theme: FrameTheme;
		url: string;
		reason: string;
		needsJson: boolean;
		dockerAvailable: boolean;
	}) {
		this.theme = options.theme;
		this.url = options.url;
		this.reason = options.reason;
		this.needsJson = options.needsJson;
		this.options = [
			{
				value: "docker",
				label: options.dockerAvailable ? "Start one with Docker" : "Start one with Docker (not found)",
				description: options.dockerAvailable
					? "searxng/searxng, bound to localhost, JSON API on"
					: "no working Docker or Podman on this machine",
				enabled: options.dockerAvailable,
			},
			{
				value: "url",
				label: "Point at an instance you already run",
				description: "enter its URL; it is checked before anything is saved",
				enabled: true,
			},
			{ value: "cancel", label: "Not now", description: "nothing is changed", enabled: true },
		];
		// Never open on a disabled row.
		if (!this.options[0]?.enabled) this.selected = 1;
	}

	/** Called by the caller while it works, so the card can narrate. */
	setWorking(line: string): void {
		this.mode = "working";
		this.progress.push(line);
		if (this.progress.length > 6) this.progress.shift();
	}

	fail(message: string): void {
		this.mode = "menu";
		this.message = message;
		this.progress = [];
	}

	handleInput(data: string): void {
		if (this.mode === "working") return;
		this.message = "";
		if (this.mode === "url") return this.handleUrlKey(data);

		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.escape)) {
			this.onDone?.(null);
			return;
		}
		if (matchesKey(data, Key.enter)) return this.choose();
	}

	private move(delta: number): void {
		const count = this.options.length;
		let next = this.selected;
		// Skip anything disabled, rather than letting the cursor rest on a row
		// that does nothing when pressed.
		for (let i = 0; i < count; i++) {
			next = (next + delta + count) % count;
			if (this.options[next]?.enabled) break;
		}
		this.selected = next;
	}

	private choose(): void {
		const option = this.options[this.selected];
		if (!option?.enabled) return;
		if (option.value === "cancel") return this.onDone?.(null);
		if (option.value === "docker") return this.onDone?.({ kind: "docker" });
		this.mode = "url";
		this.buffer = field(this.url);
	}

	private handleUrlKey(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.mode = "menu";
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const value = this.buffer.text.trim().replace(/\/+$/, "");
			if (!/^https?:\/\/[^\s]+$/i.test(value)) {
				this.message = "That is not an http(s) URL.";
				return;
			}
			this.onDone?.({ kind: "url", url: value });
			return;
		}
		const next = handleFieldKey(this.buffer, data);
		if (next) this.buffer = next;
	}

	render(width: number): string[] {
		const { theme } = this;
		const inner = Math.max(20, width - FRAME_CHROME);
		const body: string[] = [];

		const headline = this.needsJson
			? "SearXNG is running, but its JSON API is off."
			: "No SearXNG is answering.";
		body.push(theme.fg("text", strong(theme, clip(headline, inner))));
		body.push(theme.fg("dim", clip(this.url, inner)));
		body.push("");
		// While something is running, why it failed is history and the steps are
		// the story; the card is not a log of everything that ever happened.
		if (this.mode !== "working") {
			for (const line of wrap(this.reason, inner, 2)) body.push(theme.fg("muted", line));
			body.push("");
		}

		if (this.mode === "working") {
			for (const line of this.progress) {
				body.push(`  ${theme.fg("dim", elide(line, inner - 2))}`);
			}
			body.push("");
			body.push(theme.fg("dim", "this can take a few minutes on a cold pull"));
			return frame("Set up search", body, width, theme);
		}

		if (this.mode === "url") {
			body.push(theme.fg("muted", "URL of your instance:"));
			for (const line of wrap(withCursor(this.buffer), inner - 2, 2)) {
				body.push(`  ${theme.fg("text", line)}`);
			}
			body.push("");
			body.push(
				this.message
					? theme.fg("warning", clip(this.message, inner))
					: hints(
							[
								["⏎", "check and save"],
								["esc", "back"],
							],
							inner,
							theme,
						),
			);
			return frame("Set up search", body, width, theme);
		}

		this.options.forEach((option, index) => {
			const active = index === this.selected;
			const bar = active ? theme.fg("accent", "▌") : " ";
			const token = !option.enabled ? "dim" : active ? "text" : "muted";
			body.push(`${bar} ${clip(theme.fg(token, option.label), inner - 2)}`);
			body.push(`${bar} ${pad("", 2)}${clip(theme.fg("dim", option.description), inner - 4)}`);
		});

		body.push("");
		body.push(
			this.message
				? theme.fg("warning", clip(this.message, inner))
				: hints(
						[
							["↑↓", "select"],
							["⏎", "choose"],
							["esc", "cancel"],
						],
						inner,
						theme,
					),
		);

		return frame("Set up search", body, width, theme);
	}

	invalidate(): void {}
}
