import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import { DEFAULT_SETTINGS, NucleotextSettings } from "./src/settings";
import { scanVault } from "./src/vaultReader";
import {
	describeChar,
	distinctCount,
	FrequencyTable,
	totalCount,
} from "./src/frequency";
import {
	buildHuffman,
	DecodeError,
	HuffmanMapping,
	isPrefixFree,
	UnknownCharacterError,
} from "./src/huffman";
import {
	ConstraintConfig,
	gcContent,
	maxRunLength,
} from "./src/transcode";
import { decode, encode } from "./src/codec";
import { buildGenome, Genome } from "./src/genome";
import { genomeToFasta } from "./src/fasta";
import { GenomeHealthView, GENOME_HEALTH_VIEW } from "./src/healthPanel";
import { NoteSnapshot, SnapshotManager, SnapshotMap } from "./src/snapshots";
import { diffSequences } from "./src/diff";
import { classifyRegions, summarizeMutations } from "./src/classify";
import { MutationLog, MutationLogData } from "./src/mutationLog";
import { MutationLogView, MUTATION_LOG_VIEW } from "./src/mutationPanel";
import { GenomeBrowserView, GENOME_BROWSER_VIEW } from "./src/genomeBrowser";

interface NucleotextData {
	settings: NucleotextSettings;
	mapping: HuffmanMapping | null;
	/** Stage 1 (mutation tracker): per-note before/after encoded-sequence snapshots. */
	snapshots: SnapshotMap;
	/** Stage 4/5 (mutation tracker): durable per-note mutation history. */
	mutations: MutationLogData;
}

/** require() a module without throwing if it (or require itself) is absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeRequire(req: ((id: string) => any) | undefined, id: string): any {
	try {
		return req?.(id);
	} catch {
		return undefined;
	}
}

export default class NucleotextPlugin extends Plugin {
	settings: NucleotextSettings;
	mapping: HuffmanMapping | null = null;
	/** Stage 1: in-memory vault genome, rebuilt on demand and read by later stages. */
	genome: Genome | null = null;
	/** Stage 5: injected stylesheet for the health panel; removed on unload. */
	private styleEl: HTMLStyleElement | null = null;
	/** Stage 1 (mutation tracker): before/after snapshot store, fed by save events. */
	snapshots: SnapshotManager;
	/** Loaded snapshot map, kept until the manager is constructed in onload. */
	private loadedSnapshots: SnapshotMap = {};
	/** Stage 4/5 (mutation tracker): durable per-note mutation history. */
	mutationLog: MutationLog;
	/** Loaded mutation history, kept until the log is constructed in onload. */
	private loadedMutations: MutationLogData | null = null;
	/** Debounce handle for persisting the snapshot store. */
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	async onload(): Promise<void> {
		console.log("Nucleotext: loading plugin");

		await this.loadData_();
		this.addSettingTab(new NucleotextSettingTab(this.app, this));
		this.injectStyles();

		// Stage 4/5: durable mutation history. Built before the snapshot manager
		// so save-driven captures can record into it immediately.
		this.mutationLog = new MutationLog(this.loadedMutations);

		// Stage 1 (mutation tracker): snapshot store fed by note save events.
		// Stage 3/4: each genuine change is diffed, classified and logged.
		this.snapshots = new SnapshotManager(
			{
				encode: (path) => this.encodeForSnapshot(path),
				persist: () => this.schedulePersist(),
				onChange: (snapshot) => this.recordMutations(snapshot),
			},
			this.loadedSnapshots
		);
		this.registerSnapshotEvents();

		this.registerView(
			MUTATION_LOG_VIEW,
			(leaf) => new MutationLogView(leaf, this)
		);
		this.addRibbonIcon("git-compare", "Open mutation log", () =>
			this.runCommand(() => this.activateMutationView())
		);

		this.registerView(
			GENOME_HEALTH_VIEW,
			(leaf) => new GenomeHealthView(leaf, this)
		);
		this.addRibbonIcon("dna", "Open genome health panel", () =>
			this.runCommand(() => this.activateHealthView())
		);

		// Log 4: linear genome browser (its own main-area view).
		this.registerView(
			GENOME_BROWSER_VIEW,
			(leaf) => new GenomeBrowserView(leaf, this)
		);
		this.addRibbonIcon("microscope", "Open genome browser", () =>
			this.runCommand(() => this.activateGenomeBrowserView())
		);

		this.addCommand({
			id: "nucleotext-debug-frequency-table",
			name: "Build frequency table (debug)",
			callback: () => this.runCommand(() => this.debugFrequencyTable()),
		});
		this.addCommand({
			id: "nucleotext-build-encoder",
			name: "Build encoder from vault (Huffman)",
			callback: () => this.runCommand(() => this.buildEncoder()),
		});
		this.addCommand({
			id: "nucleotext-encode-current-note",
			name: "Encode current note",
			callback: () => this.runCommand(() => this.encodeCurrentNote()),
		});
		this.addCommand({
			id: "nucleotext-roundtrip-vault",
			name: "Run roundtrip test on vault",
			callback: () => this.runCommand(() => this.roundtripVault()),
		});
		this.addCommand({
			id: "nucleotext-build-genome",
			name: "Build genome (chromosomes, headers, GC)",
			callback: () => this.runCommand(() => this.buildGenomeCommand()),
		});
		this.addCommand({
			id: "nucleotext-export-fasta",
			name: "Export genome as FASTA",
			callback: () => this.runCommand(() => this.exportFasta()),
		});
		this.addCommand({
			id: "nucleotext-open-health-panel",
			name: "Open genome health panel",
			callback: () => this.runCommand(() => this.activateHealthView()),
		});
		this.addCommand({
			id: "nucleotext-dump-snapshots",
			name: "Dump snapshot store (debug)",
			callback: () => this.runCommand(() => this.dumpSnapshots()),
		});
		this.addCommand({
			id: "nucleotext-open-mutation-log",
			name: "Open mutation log",
			callback: () => this.runCommand(() => this.activateMutationView()),
		});
		this.addCommand({
			id: "nucleotext-open-genome-browser",
			name: "Open genome browser",
			callback: () => this.runCommand(() => this.activateGenomeBrowserView()),
		});
	}

	onunload(): void {
		console.log("Nucleotext: unloading plugin");
		this.styleEl?.remove();
		this.styleEl = null;
		// Flush any pending snapshot writes so nothing captured just before a
		// shutdown is lost (stage 1: snapshots must survive close/reopen).
		void this.flushSnapshots();
	}

	/**
	 * Stage 1 (mutation tracker): turn vault save/rename/delete signals into
	 * snapshot updates. `registerEvent` ties the listeners to the plugin
	 * lifecycle so they're cleaned up on unload.
	 */
	private registerSnapshotEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					!this.isExcluded(file)
				) {
					this.snapshots.onSave(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.snapshots.onRename(oldPath, file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.snapshots.onDelete(file.path);
			})
		);
	}

	/**
	 * Encode the note at `path` to its current constrained sequence for a
	 * snapshot, or return null if it can't be encoded right now (no encoder,
	 * excluded, missing, unreadable, or contains characters outside the encoder).
	 * Returning null keeps the capture a safe no-op rather than corrupting the
	 * store.
	 */
	private async encodeForSnapshot(path: string): Promise<string | null> {
		if (!this.mapping) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || this.isExcluded(file)) return null;
		try {
			const text = await this.app.vault.cachedRead(file);
			return encode(text, this.mapping, this.constraints()).constrained;
		} catch (e) {
			// UnknownCharacterError, read failures, etc. — don't snapshot garbage.
			console.warn(`Nucleotext: snapshot encode skipped for ${path}:`, e);
			return null;
		}
	}

	/** Debounced persistence of the snapshot store (and the rest of plugin data). */
	private schedulePersist(): void {
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.saveData_();
		}, 500);
	}

	/** Cancel any pending debounce and persist immediately. */
	private async flushSnapshots(): Promise<void> {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.saveData_();
	}

	/** Debug: write the snapshot store to a file and report its size. */
	private async dumpSnapshots(): Promise<void> {
		const map = this.snapshots.getMap();
		const notes = Object.values(map);
		await this.writeDebugFile("snapshots-debug.json", {
			count: notes.length,
			notes: notes.map((s) => ({
				path: s.path,
				isNew: s.isNew,
				revisions: s.revisions,
				currentLength: s.current.length,
				previousLength: s.previous === null ? null : s.previous.length,
				currentAt: s.currentAt,
				previousAt: s.previousAt,
			})),
		});
		new Notice(
			`Nucleotext: ${notes.length} note snapshot(s) stored. See snapshots-debug.json.`
		);
	}

	/**
	 * Stages 2-4 pipeline: a snapshot just moved forward. Diff previous→current,
	 * classify the regions, and log one event if there were any mutations.
	 *
	 * A brand-new note has `previous: null` (stage 1) — there's no earlier version
	 * to diff against, so it isn't an "edit event" and nothing is logged. A change
	 * that produces zero mutations is never logged either (record() guards on it),
	 * so no-op saves can't clutter the history.
	 */
	private recordMutations(snapshot: NoteSnapshot): void {
		if (snapshot.previous === null) return;
		const regions = diffSequences(snapshot.previous, snapshot.current);
		const counts = summarizeMutations(classifyRegions(regions));
		if (counts.total === 0) return;
		const basename = snapshot.path.replace(/\.md$/i, "").split("/").pop() ?? snapshot.path;
		this.mutationLog.record(snapshot.path, basename, counts, snapshot.currentAt);
		this.schedulePersist();
	}

	/** Stage 5: clear one note's history (called from the panel after confirmation). */
	async clearNoteHistory(path: string): Promise<void> {
		const removed = this.mutationLog.clearNote(path);
		if (removed > 0) {
			await this.flushSnapshots();
			new Notice(`Nucleotext: cleared ${removed} mutation event(s) for that note.`);
		}
	}

	/** Stage 5: clear the entire vault's history (called from the panel after confirmation). */
	async clearAllHistory(): Promise<void> {
		const removed = this.mutationLog.clearAll();
		if (removed > 0) {
			await this.flushSnapshots();
			new Notice(`Nucleotext: cleared all ${removed} mutation event(s) for the vault.`);
		}
	}

	/** Open (or reveal) the mutation log panel in the right sidebar. */
	private async activateMutationView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(MUTATION_LOG_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) {
				new Notice("Nucleotext: could not open a sidebar panel.");
				return;
			}
			leaf = right;
			await leaf.setViewState({ type: MUTATION_LOG_VIEW, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/** Minimal styling for the health panel (stage 5: readable, not polished). */
	private injectStyles(): void {
		const css = `
		.nucleotext-health { padding: 0 4px; }
		.nucleotext-health-head { display: flex; align-items: center;
			justify-content: space-between; gap: 8px; }
		.nucleotext-health-head h3 { margin: 8px 0; }
		.nucleotext-health-refresh { display: inline-flex; align-items: center;
			background: transparent; border: none; cursor: pointer;
			color: var(--text-muted); padding: 4px; }
		.nucleotext-health-refresh:hover { color: var(--text-normal); }
		.nucleotext-health-summary { color: var(--text-muted);
			font-size: var(--font-ui-small); margin-bottom: 2px; }
		.nucleotext-health-sortinfo { color: var(--text-faint);
			font-size: var(--font-ui-smaller); margin-bottom: 8px; }
		.nucleotext-health-empty, .nucleotext-health-note { color: var(--text-muted);
			font-size: var(--font-ui-small); padding: 8px 2px; }
		.nucleotext-health-table { width: 100%; border-collapse: collapse;
			font-size: var(--font-ui-small); }
		.nucleotext-health-table th, .nucleotext-health-table td {
			padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border);
			text-align: left; }
		.nucleotext-health-table th.is-numeric, .nucleotext-health-table td.is-numeric {
			text-align: right; font-variant-numeric: tabular-nums; }
		.nucleotext-health-table th { user-select: none; color: var(--text-muted); }
		.nucleotext-health-table th.is-sorted { color: var(--text-accent); }
		.nucleotext-health-table tbody tr:hover { background: var(--background-modifier-hover); }
		.nucleotext-health-default { color: var(--text-faint); }

		/* Stage 4/5: mutation log panel */
		.nucleotext-mut { padding: 0 4px; }
		.nucleotext-mut-head { display: flex; align-items: center;
			justify-content: space-between; gap: 8px; }
		.nucleotext-mut-head h3 { margin: 8px 0; }
		.nucleotext-mut-clearall { color: var(--text-error); background: transparent;
			border: 1px solid var(--background-modifier-border); border-radius: 4px;
			cursor: pointer; font-size: var(--font-ui-smaller); padding: 2px 8px; }
		.nucleotext-mut-clearall:hover { background: var(--background-modifier-error-hover);
			border-color: var(--text-error); }
		.nucleotext-mut-summary { color: var(--text-muted);
			font-size: var(--font-ui-small); margin-bottom: 6px; }
		.nucleotext-mut-empty { color: var(--text-muted);
			font-size: var(--font-ui-small); padding: 8px 2px; }
		.nucleotext-mut-note { border-bottom: 1px solid var(--background-modifier-border);
			padding: 2px 0; }
		.nucleotext-mut-note-head { display: flex; align-items: center; gap: 6px;
			cursor: pointer; padding: 4px 2px; }
		.nucleotext-mut-note-head:hover { background: var(--background-modifier-hover); }
		.nucleotext-mut-caret { display: inline-flex; color: var(--text-muted); }
		.nucleotext-mut-note-title { flex: 1; min-width: 0; }
		.nucleotext-mut-note-name { font-weight: var(--font-semibold);
			display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.nucleotext-mut-note-meta { color: var(--text-muted);
			font-size: var(--font-ui-smaller); }
		.nucleotext-mut-clear { color: var(--text-muted); background: transparent;
			border: none; cursor: pointer; font-size: var(--font-ui-smaller); padding: 2px 6px; }
		.nucleotext-mut-clear:hover { color: var(--text-error); }
		.nucleotext-mut-events { padding: 2px 0 4px 22px; }
		.nucleotext-mut-event { display: flex; gap: 8px; align-items: baseline;
			font-size: var(--font-ui-small); padding: 1px 0; }
		.nucleotext-mut-time { color: var(--text-faint);
			font-size: var(--font-ui-smaller); font-variant-numeric: tabular-nums;
			white-space: nowrap; }
		.nucleotext-mut-counts { color: var(--text-normal); }
		.nucleotext-mut-more { margin: 2px 0 6px 22px; background: transparent;
			border: none; color: var(--text-accent); cursor: pointer;
			font-size: var(--font-ui-smaller); padding: 2px 0; }
		.nucleotext-mut-modal-buttons { display: flex; justify-content: flex-end;
			gap: 8px; margin-top: 16px; }

		/* Log 4: genome browser */
		.nucleotext-browser { display: flex; flex-direction: column; height: 100%;
			padding: 0; }
		.nucleotext-browser-head { display: flex; align-items: center;
			justify-content: space-between; gap: 8px; padding: 0 12px;
			flex: 0 0 auto; }
		.nucleotext-browser-head h3 { margin: 8px 0; }
		.nucleotext-browser-refresh { display: inline-flex; align-items: center;
			background: transparent; border: none; cursor: pointer;
			color: var(--text-muted); padding: 4px; }
		.nucleotext-browser-refresh:hover { color: var(--text-normal); }
		.nucleotext-browser-scroll { flex: 1 1 auto; overflow: auto; min-height: 0;
			position: relative; }
		.nucleotext-browser-canvas { display: block; }
		`;
		const el = document.createElement("style");
		el.id = "nucleotext-health-styles";
		el.textContent = css;
		document.head.appendChild(el);
		this.styleEl = el;
	}

	private async runCommand(body: () => Promise<void>): Promise<void> {
		try {
			await body();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("Nucleotext:", e);
			new Notice(`Nucleotext error: ${msg}`);
		}
	}

	private constraints(): ConstraintConfig {
		return {
			maxRun: Math.max(2, this.settings.maxRun),
			gcTargetFraction: this.settings.gcTargetPercent / 100,
			homopolymer: this.settings.enableHomopolymer,
			gc: this.settings.enableGc,
		};
	}

	// --- Stage 3 -------------------------------------------------------------

	private async debugFrequencyTable(): Promise<void> {
		const result = await this.scan();
		const table = result.frequencyTable;
		const total = totalCount(table);
		const rows = Object.entries(table)
			.sort((a, b) => b[1] - a[1])
			.map(
				([ch, n]) =>
					`${describeChar(ch).padEnd(20)} ${n.toString().padStart(8)}  ${(
						(n / total) *
						100
					).toFixed(2)}%`
			);
		console.log(
			[
				"Nucleotext frequency table",
				`  files included: ${result.filesIncluded}`,
				`  files excluded: ${result.filesExcluded}`,
				`  files failed:   ${result.filesFailed.length}`,
				`  distinct chars: ${distinctCount(table)}`,
				`  total chars:    ${total}`,
				"  ----------------------------------------",
				...rows,
			].join("\n")
		);
		if (result.filesFailed.length > 0) {
			console.warn("Nucleotext: files that failed to read:", result.filesFailed);
		}
		await this.writeDebugFile("frequency-table-debug.json", {
			...result,
			frequencyTable: table,
		});
		new Notice(
			`Nucleotext: ${distinctCount(table)} distinct chars across ${total} chars. See console.`
		);
	}

	// --- Stage 4 -------------------------------------------------------------

	private async buildEncoder(): Promise<void> {
		const result = await this.scan();
		const table: FrequencyTable = result.frequencyTable;
		if (distinctCount(table) === 0) {
			new Notice("Nucleotext: no readable content found to build encoder.");
			return;
		}
		const mapping = buildHuffman(table);
		const conflict = isPrefixFree(mapping);
		if (conflict) {
			throw new Error(
				`Internal error: mapping not prefix-free (${describeChar(
					conflict.a
				)} vs ${describeChar(conflict.b)}).`
			);
		}
		this.mapping = mapping;
		await this.saveData_();
		await this.writeDebugFile("encoder-mapping.json", mapping);
		console.log(
			`Nucleotext: encoder built for ${distinctCount(table)} chars (prefix-free verified).`
		);
		new Notice(
			`Nucleotext: encoder built for ${distinctCount(table)} chars and saved.`
		);
	}

	// --- Stages 5 + 6: constrained encode -----------------------------------

	private async encodeCurrentNote(): Promise<void> {
		if (!this.mapping) {
			new Notice('Nucleotext: no encoder yet. Run "Build encoder from vault" first.');
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Nucleotext: no active note to encode.");
			return;
		}
		const text = await this.app.vault.cachedRead(file);
		const cfg = this.constraints();
		try {
			const { raw, constrained } = encode(text, this.mapping, cfg);
			const report = {
				path: file.path,
				chars: [...text].length,
				config: cfg,
				raw: {
					bases: raw.length,
					maxRun: maxRunLength(raw),
					gcPercent: +(gcContent(raw) * 100).toFixed(2),
				},
				constrained: {
					bases: constrained.length,
					maxRun: maxRunLength(constrained),
					gcPercent: +(gcContent(constrained) * 100).toFixed(2),
				},
				sequence: constrained,
			};
			console.log("Nucleotext encoded note:", report);
			await this.writeDebugFile("last-encoded.json", report);
			new Notice(
				`Nucleotext: ${report.chars} chars → ${constrained.length} bases. ` +
					`maxRun ${report.raw.maxRun}→${report.constrained.maxRun}, ` +
					`GC ${report.raw.gcPercent}%→${report.constrained.gcPercent}% ` +
					`(target ${this.settings.gcTargetPercent}%). See console.`
			);
		} catch (e) {
			if (e instanceof UnknownCharacterError) {
				new Notice(
					`Nucleotext: note uses ${e.unknownChars.length} character(s) not in the ` +
						`encoder. Rebuild the encoder to include them.`
				);
				console.warn("Nucleotext: unknown characters:", e.unknownChars);
				return;
			}
			throw e;
		}
	}

	// --- Stage 7: decode + roundtrip ----------------------------------------

	private async roundtripVault(): Promise<void> {
		if (!this.mapping) {
			new Notice('Nucleotext: no encoder yet. Run "Build encoder from vault" first.');
			return;
		}
		const cfg = this.constraints();
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !this.isExcluded(f));

		interface Row {
			path: string;
			chars: number;
			bases: number;
			rawMaxRun: number;
			conMaxRun: number;
			rawGc: number;
			conGc: number;
			ok: boolean;
			note?: string;
		}
		const rows: Row[] = [];

		const tryNote = async (path: string, text: string): Promise<void> => {
			try {
				const { raw, constrained } = encode(text, this.mapping!, cfg);
				const back = decode(constrained, this.mapping, cfg);
				const ok = back === text;
				rows.push({
					path,
					chars: [...text].length,
					bases: constrained.length,
					rawMaxRun: maxRunLength(raw),
					conMaxRun: maxRunLength(constrained),
					rawGc: +(gcContent(raw) * 100).toFixed(1),
					conGc: +(gcContent(constrained) * 100).toFixed(1),
					ok,
					note: ok ? undefined : "MISMATCH",
				});
			} catch (e) {
				rows.push({
					path,
					chars: [...text].length,
					bases: 0,
					rawMaxRun: 0,
					conMaxRun: 0,
					rawGc: 0,
					conGc: 0,
					ok: false,
					note: e instanceof Error ? e.message : String(e),
				});
			}
		};

		for (const file of files) {
			let text: string;
			try {
				text = await this.app.vault.cachedRead(file);
			} catch (e) {
				rows.push({
					path: file.path,
					chars: 0,
					bases: 0,
					rawMaxRun: 0,
					conMaxRun: 0,
					rawGc: 0,
					conGc: 0,
					ok: false,
					note: `read failed: ${String(e)}`,
				});
				continue;
			}
			await tryNote(file.path, text);
		}

		// Explicit edge cases (stage 7 requirement).
		await tryNote("<empty>", "");
		await tryNote("<whitespace>", "   \n\t  \n");

		// Corrupted-mapping check: decode must fail loudly, not silently.
		let corruptOk = false;
		let corruptMsg = "";
		try {
			const sample = encode("test", this.mapping, cfg).constrained;
			const corrupt: HuffmanMapping = { version: 1, codes: { x: "ZZ" } };
			decode(sample, corrupt, cfg);
		} catch (e) {
			corruptOk = e instanceof DecodeError;
			corruptMsg = e instanceof Error ? e.message : String(e);
		}

		const passed = rows.filter((r) => r.ok).length;
		const overLimit = rows.filter(
			(r) => cfg.homopolymer && r.conMaxRun > Math.max(2, cfg.maxRun)
		).length;

		console.log(
			[
				"Nucleotext roundtrip report",
				`  config: ${JSON.stringify(cfg)}`,
				`  notes tested: ${rows.length}, passed: ${passed}, failed: ${rows.length - passed}`,
				`  homopolymer over limit: ${overLimit}`,
				`  corrupt-mapping rejected: ${corruptOk} (${corruptMsg})`,
				"  ----------------------------------------",
				...rows.map(
					(r) =>
						`${r.ok ? "PASS" : "FAIL"}  ${r.path.padEnd(30).slice(0, 30)} ` +
						`chars=${r.chars} bases=${r.bases} ` +
						`run ${r.rawMaxRun}->${r.conMaxRun} gc ${r.rawGc}->${r.conGc}% ` +
						`${r.note ?? ""}`
				),
			].join("\n")
		);
		await this.writeDebugFile("roundtrip-report.json", {
			config: cfg,
			passed,
			failed: rows.length - passed,
			overLimit,
			corruptRejected: corruptOk,
			rows,
		});
		new Notice(
			`Nucleotext roundtrip: ${passed}/${rows.length} passed, ` +
				`${overLimit} over homopolymer limit, ` +
				`corrupt-map rejected: ${corruptOk}. See console.`
		);
	}

	// --- Stages 1-4: genome (chromosomes, headers, GC) ----------------------

	/**
	 * Build the in-memory genome and report it. Stages 1 (grouping), 2 (headers)
	 * and 4 (GC) all land in `this.genome`, so the export and later panel can read
	 * it without re-walking the vault.
	 */
	private async buildGenomeCommand(): Promise<void> {
		const genome = await this.ensureGenome(true);
		if (!genome) return;

		const noteCount = genome.chromosomes.reduce(
			(n, c) => n + c.notes.length,
			0
		);
		console.log(
			[
				"Nucleotext genome",
				`  chromosomes: ${genome.chromosomes.length}`,
				`  notes:       ${noteCount}`,
				`  total bases: ${genome.length}`,
				`  genome GC:   ${genome.gcPercent}% (aggregate over all bases)`,
				`  encode failures: ${genome.failures.length}`,
				"  ----------------------------------------",
				...genome.chromosomes.map(
					(c) =>
						`${c.name.padEnd(24).slice(0, 24)} ` +
						`notes=${c.notes.length.toString().padStart(4)} ` +
						`bases=${c.length.toString().padStart(8)} ` +
						`GC=${c.gcPercent.toFixed(2)}%`
				),
			].join("\n")
		);
		if (genome.failures.length > 0) {
			console.warn("Nucleotext: notes that failed to encode:", genome.failures);
		}

		// Debug summary WITHOUT raw sequences, so the file stays readable.
		await this.writeDebugFile("genome-summary.json", {
			generatedAt: genome.generatedAt,
			defaultChromosome: genome.defaultChromosome,
			totals: {
				chromosomes: genome.chromosomes.length,
				notes: noteCount,
				bases: genome.length,
				gcCount: genome.gcCount,
				gcPercent: genome.gcPercent,
			},
			failures: genome.failures,
			chromosomes: genome.chromosomes.map((c) => ({
				name: c.name,
				notes: c.notes.length,
				bases: c.length,
				gcCount: c.gcCount,
				gcPercent: c.gcPercent,
				records: c.notes.map((n) => ({
					path: n.path,
					header: n.header,
					bases: n.length,
					gcCount: n.gcCount,
					gcPercent: n.gcPercent,
				})),
			})),
		});

		new Notice(
			`Nucleotext: genome built — ${genome.chromosomes.length} chromosomes, ` +
				`${noteCount} notes, GC ${genome.gcPercent}%. See console.`
		);
	}

	/** Stage 3: export the whole genome as a single valid FASTA file. */
	private async exportFasta(): Promise<void> {
		const genome = await this.ensureGenome(false);
		if (!genome) return;

		const fasta = genomeToFasta(genome);
		const noteCount = genome.chromosomes.reduce(
			(n, c) => n + c.notes.length,
			0
		);

		const saved = await this.saveTextWithDialog("vault-genome.fasta", fasta);
		if (!saved) {
			new Notice("Nucleotext: FASTA export cancelled.");
			return;
		}
		new Notice(
			`Nucleotext: exported ${noteCount} record(s) across ` +
				`${genome.chromosomes.length} chromosome(s) to ${saved}.`
		);
	}

	/**
	 * Public hook for the health panel (stage 5): rebuild the genome from the
	 * live vault so folder add/remove/rename is reflected, and return it (or null
	 * if there's no encoder yet).
	 */
	async refreshGenome(): Promise<Genome | null> {
		return this.ensureGenome(true);
	}

	/** Open (or reveal) the genome health panel in the right sidebar. */
	private async activateHealthView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GENOME_HEALTH_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) {
				new Notice("Nucleotext: could not open a sidebar panel.");
				return;
			}
			leaf = right;
			await leaf.setViewState({ type: GENOME_HEALTH_VIEW, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/**
	 * Open (or reveal) the genome browser in a main-area pane (log 4). Reuses the
	 * existing leaf if one is already open so repeated triggers don't stack up
	 * duplicate panes.
	 */
	private async activateGenomeBrowserView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(GENOME_BROWSER_VIEW)[0];
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: GENOME_BROWSER_VIEW, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/**
	 * Return a fresh genome, building it if needed. Requires an encoder mapping;
	 * if none exists it tells the user to build one and returns null.
	 * When `force` is true the genome is always rebuilt (used by the build
	 * command); otherwise a cached genome is reused.
	 */
	private async ensureGenome(force: boolean): Promise<Genome | null> {
		if (!this.mapping) {
			new Notice(
				'Nucleotext: no encoder yet. Run "Build encoder from vault" first.'
			);
			return null;
		}
		if (!force && this.genome) return this.genome;
		this.genome = await buildGenome(
			this.app,
			this.mapping,
			this.constraints(),
			this.settings.excludedFolders
		);
		return this.genome;
	}

	/**
	 * Save text to a user-chosen location via a normal save dialog. Uses the
	 * Electron native dialog on desktop and falls back to a browser download
	 * (e.g. on mobile, where Electron isn't available). Returns the saved path,
	 * or null if the user cancelled.
	 */
	private async saveTextWithDialog(
		defaultName: string,
		content: string
	): Promise<string | null> {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const req = (window as any).require?.bind(window);
			const electron = req?.("electron");
			const remote = electron?.remote ?? safeRequire(req, "@electron/remote");
			const dialog = remote?.dialog ?? electron?.dialog;
			if (dialog?.showSaveDialog && req) {
				const result = await dialog.showSaveDialog({
					title: "Export genome as FASTA",
					defaultPath: defaultName,
					filters: [
						{ name: "FASTA", extensions: ["fasta", "fa", "fna"] },
						{ name: "All files", extensions: ["*"] },
					],
				});
				if (result.canceled || !result.filePath) return null;
				const fs = req("fs");
				fs.writeFileSync(result.filePath, content, "utf8");
				return result.filePath;
			}
		} catch (e) {
			console.warn(
				"Nucleotext: native save dialog unavailable, falling back to download:",
				e
			);
		}
		// Fallback: trigger a browser download.
		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = defaultName;
		a.click();
		URL.revokeObjectURL(url);
		return defaultName;
	}

	// --- shared --------------------------------------------------------------

	private scan() {
		return scanVault(this.app, this.settings.excludedFolders);
	}

	private isExcluded(file: TFile): boolean {
		// Reuse the reader's exclusion logic via a scan would be wasteful here;
		// mirror it cheaply for the roundtrip filter.
		const p = file.path.toLowerCase();
		return this.settings.excludedFolders.some((folder) => {
			const f = folder.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
			if (f === "") return false;
			return p === f || p === `${f}.md` || p.startsWith(`${f}/`);
		});
	}

	private async writeDebugFile(name: string, data: unknown): Promise<void> {
		const dir = this.manifest.dir;
		if (!dir) return;
		try {
			await this.app.vault.adapter.write(
				`${dir}/${name}`,
				JSON.stringify(data, null, 2)
			);
		} catch (e) {
			console.warn(`Nucleotext: could not write debug file ${name}:`, e);
		}
	}

	private async loadData_(): Promise<void> {
		const raw = (await this.loadData()) as Partial<NucleotextData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);
		this.mapping = raw?.mapping ?? null;
		this.loadedSnapshots = raw?.snapshots ?? {};
		this.loadedMutations = raw?.mutations ?? null;
	}

	private async saveData_(): Promise<void> {
		const data: NucleotextData = {
			settings: this.settings,
			mapping: this.mapping,
			// Read straight from the manager once it exists so we persist the
			// live store, not the stale copy loaded at startup.
			snapshots: this.snapshots?.getMap() ?? this.loadedSnapshots,
			mutations: this.mutationLog?.toData() ??
				this.loadedMutations ?? { version: 1, events: [] },
		};
		await this.saveData(data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData_();
	}
}

class NucleotextSettingTab extends PluginSettingTab {
	plugin: NucleotextPlugin;

	constructor(app: App, plugin: NucleotextPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Nucleotext")
			.setDesc("Encode your vault into constrained DNA sequences.")
			.setHeading();

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Folders to keep out of the genome entirely, one per line " +
					"(e.g. a private journal). Vault-relative paths."
			)
			.addTextArea((ta) => {
				ta.setPlaceholder("Journal\nArchive/Private")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				ta.inputEl.rows = 4;
				ta.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("Constraints")
			.setDesc("Real DNA-storage limits applied on top of the encoder.")
			.setHeading();

		new Setting(containerEl)
			.setName("Enforce homopolymer limit")
			.setDesc("Stage 5: cap runs of an identical base.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableHomopolymer).onChange(async (v) => {
					this.plugin.settings.enableHomopolymer = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Maximum homopolymer run length")
			.setDesc("Longest allowed run of the same base (minimum 2).")
			.addSlider((s) =>
				s
					.setLimits(2, 10, 1)
					.setValue(this.plugin.settings.maxRun)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.maxRun = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bias toward target GC content")
			.setDesc("Stage 6: steer the sequence toward a target GC ratio.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableGc).onChange(async (v) => {
					this.plugin.settings.enableGc = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Target GC content (%)")
			.setDesc("Default 50%, as in real DNA-storage systems.")
			.addSlider((s) =>
				s
					.setLimits(0, 100, 1)
					.setValue(this.plugin.settings.gcTargetPercent)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.gcTargetPercent = v;
						await this.plugin.saveSettings();
					})
			);
	}
}
