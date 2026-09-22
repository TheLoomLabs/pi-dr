import { Key, matchesKey } from "@earendil-works/pi-tui";
import { clip, elide, FRAME_CHROME, FRAME_ROWS, frame, hints, pad, wrap, type FrameTheme } from "./frame.ts";
import { field as makeField, handleFieldKey, withCursor, type Field as TextField } from "./field.ts";
import { adjust, defaultFor, editable, FIELDS, format, parse, type Field } from "../settings-fields.ts";
import { ENV_VARS, type ResolvedTunables, type Tunables } from "../settings.ts";

/**
 * Every tunable, on screen, editable.
 *
 * Numbers and choices change in place with ← →, because that is the whole
 * interaction for them and a text box would be a worse way to type "8". Text
 * and domain lists open an inline field on ⏎.
 *
 * A field the environment is overriding is shown with its live value and the
 * tag `env`, and refuses to be edited: writing to the file would change
 * nothing you can see, which is the worst thing a settings screen can do.
 */
export class SettingsCard {
	private readonly theme: FrameTheme;
	private resolved: ResolvedTunables;
	private working: Tunables;
	private selected = 0;
	private top = 0;
	private editing: TextField | undefined;
	private message = "";
	private saved = "";

	/** Called with the whole settings object whenever something changes. */
	public onChange?: (values: Partial<Tunables>) => { ok: boolean; error?: string };
	public onClose?: () => void;

	constructor(theme: FrameTheme, resolved: ResolvedTunables, values: Tunables) {
		this.theme = theme;
		this.resolved = resolved;
		this.working = { ...values };
	}

	private current(): Field {
		return FIELDS[this.selected] as Field;
	}

	private overridden(field: Field): boolean {
		return this.resolved[field.key].source === "env";
	}

	handleInput(data: string): void {
		this.message = "";
		this.saved = "";
		if (this.editing) return this.handleEditKey(data);

		if (matchesKey(data, Key.escape)) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, Key.up)) return this.select(this.selected - 1);
		if (matchesKey(data, Key.down)) return this.select(this.selected + 1);
		if (matchesKey(data, Key.left)) return this.nudge(-1);
		if (matchesKey(data, Key.right)) return this.nudge(1);
		if (matchesKey(data, Key.enter)) return this.beginEdit();
		if (data === "r") return this.reset();
	}

	private select(index: number): void {
		this.selected = Math.max(0, Math.min(FIELDS.length - 1, index));
	}

	private guard(field: Field): boolean {
		if (!this.overridden(field)) return true;
		this.message = `${ENV_VARS[field.key]} is set in the environment and wins. Unset it to edit this here.`;
		return false;
	}

	private nudge(delta: number): void {
		const field = this.current();
		if (field.kind !== "number" && field.kind !== "choice") return;
		if (!this.guard(field)) return;
		this.commit(field, adjust(field, this.working[field.key], delta));
	}

	private beginEdit(): void {
		const field = this.current();
		if (field.kind === "number" || field.kind === "choice") {
			// ← → is the interaction for these; ⏎ opening a text box for a number
			// between 1 and 30 would be a worse way to say the same thing.
			if (this.guard(field)) this.message = "Use ← → to change this one.";
			return;
		}
		if (!this.guard(field)) return;
		this.editing = makeField(editable(field, this.working[field.key]));
	}

	private handleEditKey(data: string): void {
		if (!this.editing) return;
		if (matchesKey(data, Key.escape)) {
			this.editing = undefined;
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const field = this.current();
			const result = parse(field, this.editing.text);
			if (result.error) {
				this.message = result.error;
				return;
			}
			this.editing = undefined;
			this.commit(field, result.value);
			return;
		}
		const next = handleFieldKey(this.editing, data);
		if (next) this.editing = next;
	}

	private reset(): void {
		const field = this.current();
		if (!this.guard(field)) return;
		this.commit(field, defaultFor(field));
	}

	/** Applied and persisted as it changes: a settings screen with a save button
	 *  is a settings screen where half the changes are lost to Escape. */
	private commit(field: Field, value: unknown): void {
		(this.working[field.key] as unknown) = value;
		const result = this.onChange?.({ [field.key]: value } as Partial<Tunables>);
		if (result && !result.ok) {
			this.message = `Could not save: ${result.error ?? "unknown error"}`;
			return;
		}
		this.saved = "saved";
	}

	/** The live values, for a caller that needs them after the card closes. */
	values(): Tunables {
		return { ...this.working };
	}

	render(width: number, rows = 24): string[] {
		const { theme } = this;
		const inner = Math.max(24, width - FRAME_CHROME);
		const labelWidth = Math.min(24, Math.max(...FIELDS.map((f) => f.label.length)) + 1);

		const foot: string[] = ["", ...wrap(this.current().help, inner, 2).map((l) => theme.fg("dim", l)), "", this.footer(inner)];
		const room = rows - FRAME_ROWS - foot.length;

		// Groups cost a row each, so the window is measured in rendered rows
		// rather than in fields.
		const lines: string[] = [];
		let group = "";
		const rendered: { index: number; line: string }[] = [];
		FIELDS.forEach((field, index) => {
			if (field.group !== group) {
				group = field.group;
				rendered.push({ index: -1, line: theme.fg("muted", group) });
			}
			rendered.push({ index, line: this.row(field, index, inner, labelWidth) });
		});

		const selectedRow = rendered.findIndex((entry) => entry.index === this.selected);
		if (selectedRow < this.top) this.top = selectedRow;
		else if (selectedRow >= this.top + room) this.top = selectedRow - room + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, rendered.length - room)));

		for (const entry of rendered.slice(this.top, this.top + room)) lines.push(entry.line);

		return frame("Deep research settings", [...lines, ...foot], width, theme);
	}

	private row(field: Field, index: number, inner: number, labelWidth: number): string {
		const { theme } = this;
		const active = index === this.selected;
		const env = this.overridden(field);
		const bar = active ? theme.fg("accent", "▌") : " ";

		const shown =
			active && this.editing ? withCursor(this.editing) : format(field, this.working[field.key]);
		const tag = env ? " env" : this.resolved[field.key].source === "file" ? "" : "";
		const room = inner - labelWidth - 3 - tag.length;

		return (
			`${bar} ` +
			theme.fg(active ? "text" : "muted", pad(field.label, labelWidth)) +
			theme.fg(env ? "dim" : active ? "accent" : "dim", pad(elide(shown, Math.max(4, room)), room)) +
			theme.fg("warning", tag)
		);
	}

	private footer(inner: number): string {
		const { theme } = this;
		if (this.message) return clip(theme.fg("warning", this.message), inner);
		if (this.saved) return theme.fg("success", this.saved);

		const field = this.current();
		const change: [string, string] =
			field.kind === "number" || field.kind === "choice" ? ["←→", "change"] : ["⏎", "edit"];
		return hints(
			[["↑↓", "select"], change, ["r", "default"], ["esc", "back"]],
			inner,
			theme,
		);
	}

	invalidate(): void {}
}
