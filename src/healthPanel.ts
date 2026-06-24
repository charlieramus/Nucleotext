import { ItemView, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type NucleotextPlugin from "../main";
import { Chromosome, Genome } from "./genome";

/**
 * Stage 5 — Genomic health panel.
 *
 * A simple, readable first-pass list (deliberately NOT the genome browser: no
 * canvas/SVG). It lists every chromosome with its GC% and total sequence
 * length, and lets the user sort by GC% or by length with the active sort
 * clearly indicated.
 *
 * The panel rebuilds the genome from the live vault whenever it opens and
 * whenever a file is created, deleted or renamed, so a folder being added,
 * removed or renamed is reflected even before any note-level edit tracking
 * exists.
 */
export const GENOME_HEALTH_VIEW = "nucleotext-genome-health";

type SortKey = "name" | "notes" | "length" | "gc";
type SortDir = "asc" | "desc";

interface Column {
	key: SortKey;
	label: string;
	numeric: boolean;
}

const COLUMNS: Column[] = [
	{ key: "name", label: "Chromosome", numeric: false },
	{ key: "notes", label: "Notes", numeric: true },
	{ key: "length", label: "Length (bases)", numeric: true },
	{ key: "gc", label: "GC %", numeric: true },
];

export class GenomeHealthView extends ItemView {
	private readonly plugin: NucleotextPlugin;
	private genome: Genome | null = null;
	private loading = false;
	private sortKey: SortKey = "gc";
	private sortDir: SortDir = "desc";
	private readonly scheduleRefresh: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: NucleotextPlugin) {
		super(leaf);
		this.plugin = plugin;
		// Coalesce bursts of vault events (e.g. a folder rename touching many files).
		this.scheduleRefresh = debounce(() => void this.refresh(), 400, true);
	}

	getViewType(): string {
		return GENOME_HEALTH_VIEW;
	}

	getDisplayText(): string {
		return "Genome health";
	}

	getIcon(): string {
		return "dna";
	}

	async onOpen(): Promise<void> {
		// Folder add/remove/rename all surface as file create/delete/rename here.
		this.registerEvent(this.app.vault.on("create", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("delete", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("rename", this.scheduleRefresh));
		await this.refresh();
	}

	/** Rebuild the genome from the current vault and re-render. */
	async refresh(): Promise<void> {
		this.loading = true;
		this.render();
		this.genome = await this.plugin.refreshGenome();
		this.loading = false;
		this.render();
	}

	private setSort(key: SortKey): void {
		if (this.sortKey === key) {
			this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
		} else {
			this.sortKey = key;
			// Sensible default direction: high-to-low for metrics, A-Z for names.
			this.sortDir = key === "name" ? "asc" : "desc";
		}
		this.render();
	}

	private sortedChromosomes(): Chromosome[] {
		const genome = this.genome;
		if (!genome) return [];
		const dir = this.sortDir === "asc" ? 1 : -1;
		return [...genome.chromosomes].sort((a, b) => {
			let r = 0;
			switch (this.sortKey) {
				case "name":
					r = a.name.localeCompare(b.name);
					break;
				case "notes":
					r = a.notes.length - b.notes.length;
					break;
				case "length":
					r = a.length - b.length;
					break;
				case "gc":
					r = a.gcPercent - b.gcPercent;
					break;
			}
			if (r === 0) r = a.name.localeCompare(b.name); // stable tiebreak
			return r * dir;
		});
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass("nucleotext-health");

		const head = root.createDiv({ cls: "nucleotext-health-head" });
		head.createEl("h3", { text: "Genome health" });
		const refreshBtn = head.createEl("button", { cls: "nucleotext-health-refresh" });
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.setAttr("aria-label", "Rebuild from vault");
		refreshBtn.onclick = () => void this.refresh();

		if (this.loading) {
			root.createDiv({ cls: "nucleotext-health-empty", text: "Building genome…" });
			return;
		}

		const genome = this.genome;
		if (!genome) {
			root.createDiv({
				cls: "nucleotext-health-empty",
				text:
					'No genome yet. Run "Build encoder from vault", then reopen this panel.',
			});
			return;
		}

		const noteCount = genome.chromosomes.reduce((n, c) => n + c.notes.length, 0);
		if (genome.chromosomes.length === 0) {
			root.createDiv({
				cls: "nucleotext-health-empty",
				text: "No chromosomes — the vault has no encodable notes yet.",
			});
			return;
		}

		// Summary line gives the whole-genome figures at a glance.
		root.createDiv({
			cls: "nucleotext-health-summary",
			text:
				`${genome.chromosomes.length} chromosome${genome.chromosomes.length === 1 ? "" : "s"} · ` +
				`${noteCount} note${noteCount === 1 ? "" : "s"} · ` +
				`${genome.length.toLocaleString()} bases · GC ${genome.gcPercent.toFixed(2)}%`,
		});

		root.createDiv({
			cls: "nucleotext-health-sortinfo",
			text: `Sorted by ${labelFor(this.sortKey)} (${this.sortDir === "asc" ? "ascending" : "descending"})`,
		});

		const table = root.createEl("table", { cls: "nucleotext-health-table" });
		const headRow = table.createEl("thead").createEl("tr");
		for (const col of COLUMNS) {
			const th = headRow.createEl("th", { cls: col.numeric ? "is-numeric" : "" });
			const active = this.sortKey === col.key;
			th.setText(col.label + (active ? (this.sortDir === "asc" ? " ▲" : " ▼") : ""));
			if (active) th.addClass("is-sorted");
			th.style.cursor = "pointer";
			th.onclick = () => this.setSort(col.key);
		}

		const body = table.createEl("tbody");
		for (const chr of this.sortedChromosomes()) {
			const tr = body.createEl("tr");
			const nameCell = tr.createEl("td");
			nameCell.setText(chr.name);
			if (chr.name === genome.defaultChromosome) {
				nameCell.createSpan({
					cls: "nucleotext-health-default",
					text: " (root notes)",
				});
			}
			tr.createEl("td", { cls: "is-numeric", text: chr.notes.length.toLocaleString() });
			tr.createEl("td", { cls: "is-numeric", text: chr.length.toLocaleString() });
			tr.createEl("td", { cls: "is-numeric", text: `${chr.gcPercent.toFixed(2)}%` });
		}

		if (genome.failures.length > 0) {
			root.createDiv({
				cls: "nucleotext-health-note",
				text: `${genome.failures.length} note(s) could not be encoded and are excluded. See console.`,
			});
		}
	}
}

function labelFor(key: SortKey): string {
	return COLUMNS.find((c) => c.key === key)?.label ?? key;
}
