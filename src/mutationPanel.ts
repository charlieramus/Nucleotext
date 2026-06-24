import { App, ItemView, Modal, WorkspaceLeaf, setIcon } from "obsidian";
import type NucleotextPlugin from "../main";
import { describeCounts } from "./classify";
import { MutationLog, NoteHistory } from "./mutationLog";

/**
 * Stage 4 (mutation tracker) — Mutation Log Panel, plus Stage 5 history controls.
 *
 * Shows one readable entry per edit event, grouped under the note it belongs to,
 * and updates live as new saves are processed (it subscribes to the
 * {@link MutationLog} and re-renders on every change — no manual refresh).
 *
 * Long histories stay readable: each note section collapses, and within a note
 * only the most recent {@link VISIBLE_PER_NOTE} events show until the user asks
 * for the rest. A save with zero mutations never reaches the log, so empty
 * entries can't clutter it.
 *
 * Stage 5 adds the clear controls rendered here: a per-note clear button and a
 * vault-wide "Clear all", each behind a confirmation modal, with the vault-wide
 * action visually and textually distinguished so it's hard to trigger by mistake.
 */
export const MUTATION_LOG_VIEW = "nucleotext-mutation-log";

/** How many of a note's most recent events to show before "show older". */
const VISIBLE_PER_NOTE = 25;

export class MutationLogView extends ItemView {
	private readonly plugin: NucleotextPlugin;
	private readonly log: MutationLog;
	private unsubscribe: (() => void) | null = null;
	/** Notes whose section the user has collapsed. */
	private collapsed = new Set<string>();
	/** Notes for which the user expanded the full (older) history. */
	private showAll = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: NucleotextPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.log = plugin.mutationLog;
	}

	getViewType(): string {
		return MUTATION_LOG_VIEW;
	}

	getDisplayText(): string {
		return "Mutation log";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		// Live updates: re-render whenever the log changes (a new event, or a clear).
		this.unsubscribe = this.log.subscribe(() => this.render());
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("nucleotext-mut");

		const head = root.createDiv({ cls: "nucleotext-mut-head" });
		head.createEl("h3", { text: "Mutation log" });

		const notes = this.log.byNote();
		const totalEvents = this.log.size();

		if (totalEvents > 0) {
			const clearAll = head.createEl("button", {
				cls: "nucleotext-mut-clearall",
				text: "Clear all",
			});
			clearAll.setAttr("aria-label", "Clear mutation history for the entire vault");
			clearAll.onclick = () => this.confirmClearAll(notes.length, totalEvents);
		}

		if (notes.length === 0) {
			root.createDiv({
				cls: "nucleotext-mut-empty",
				text: "No mutations yet. Edit and save an encoded note to see its mutations here.",
			});
			return;
		}

		root.createDiv({
			cls: "nucleotext-mut-summary",
			text:
				`${totalEvents} edit event${totalEvents === 1 ? "" : "s"} across ` +
				`${notes.length} note${notes.length === 1 ? "" : "s"}`,
		});

		for (const note of notes) this.renderNote(root, note);
	}

	private renderNote(root: HTMLElement, note: NoteHistory): void {
		const section = root.createDiv({ cls: "nucleotext-mut-note" });

		const header = section.createDiv({ cls: "nucleotext-mut-note-head" });
		const isCollapsed = this.collapsed.has(note.path);

		const toggle = header.createSpan({ cls: "nucleotext-mut-caret" });
		setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");

		const title = header.createDiv({ cls: "nucleotext-mut-note-title" });
		title.createSpan({ cls: "nucleotext-mut-note-name", text: note.basename });
		title.createSpan({
			cls: "nucleotext-mut-note-meta",
			text:
				`${note.events.length} edit${note.events.length === 1 ? "" : "s"} · ` +
				describeCounts(note.totals),
		});

		// Clicking the header (but not the clear button) toggles collapse.
		header.onclick = () => {
			if (isCollapsed) this.collapsed.delete(note.path);
			else this.collapsed.add(note.path);
			this.render();
		};

		const clearBtn = header.createEl("button", {
			cls: "nucleotext-mut-clear",
			text: "Clear",
		});
		clearBtn.setAttr("aria-label", `Clear mutation history for ${note.basename}`);
		clearBtn.onclick = (ev) => {
			ev.stopPropagation();
			this.confirmClearNote(note);
		};

		if (isCollapsed) return;

		const list = section.createDiv({ cls: "nucleotext-mut-events" });
		const expanded = this.showAll.has(note.path);
		const visible = expanded
			? note.events
			: note.events.slice(0, VISIBLE_PER_NOTE);

		for (const e of visible) {
			const row = list.createDiv({ cls: "nucleotext-mut-event" });
			row.createSpan({
				cls: "nucleotext-mut-time",
				text: formatTime(e.timestamp),
			});
			row.createSpan({
				cls: "nucleotext-mut-counts",
				text: describeCounts(e.counts),
			});
		}

		const hidden = note.events.length - visible.length;
		if (hidden > 0) {
			const more = section.createEl("button", {
				cls: "nucleotext-mut-more",
				text: `Show ${hidden} older edit${hidden === 1 ? "" : "s"}`,
			});
			more.onclick = () => {
				this.showAll.add(note.path);
				this.render();
			};
		} else if (expanded && note.events.length > VISIBLE_PER_NOTE) {
			const less = section.createEl("button", {
				cls: "nucleotext-mut-more",
				text: "Show fewer",
			});
			less.onclick = () => {
				this.showAll.delete(note.path);
				this.render();
			};
		}
	}

	private confirmClearNote(note: NoteHistory): void {
		new ConfirmModal(this.app, {
			title: "Clear note history",
			body:
				`Delete all ${note.events.length} mutation event${note.events.length === 1 ? "" : "s"} ` +
				`for "${note.basename}"? Other notes are not affected. This cannot be undone.`,
			confirmText: "Clear this note",
			danger: false,
			onConfirm: () => void this.plugin.clearNoteHistory(note.path),
		}).open();
	}

	private confirmClearAll(noteCount: number, eventCount: number): void {
		new ConfirmModal(this.app, {
			title: "Clear ALL mutation history",
			body:
				`This deletes the ENTIRE vault's mutation history — ` +
				`${eventCount} event${eventCount === 1 ? "" : "s"} across ${noteCount} ` +
				`note${noteCount === 1 ? "" : "s"}. Every note's history is removed, not just one. ` +
				`This cannot be undone.`,
			confirmText: "Clear everything",
			danger: true,
			onConfirm: () => void this.plugin.clearAllHistory(),
		}).open();
	}
}

interface ConfirmOptions {
	title: string;
	body: string;
	confirmText: string;
	/** Render the confirm button as destructive (used for the vault-wide clear). */
	danger: boolean;
	onConfirm: () => void;
}

/** Minimal confirmation modal — nothing is deleted until the user confirms here. */
class ConfirmModal extends Modal {
	constructor(app: App, private opts: ConfirmOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.opts.title);
		contentEl.createEl("p", { text: this.opts.body });

		const buttons = contentEl.createDiv({ cls: "nucleotext-mut-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();

		const confirm = buttons.createEl("button", { text: this.opts.confirmText });
		confirm.addClass("mod-cta");
		if (this.opts.danger) confirm.addClass("mod-warning");
		confirm.onclick = () => {
			this.opts.onConfirm();
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Compact local timestamp, e.g. "Jun 24, 14:03:09". */
function formatTime(ts: number): string {
	const d = new Date(ts);
	const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const time = d.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return `${date}, ${time}`;
}
