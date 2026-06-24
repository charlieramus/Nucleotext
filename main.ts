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

interface NucleotextData {
	settings: NucleotextSettings;
	mapping: HuffmanMapping | null;
}

export default class NucleotextPlugin extends Plugin {
	settings: NucleotextSettings;
	mapping: HuffmanMapping | null = null;

	async onload(): Promise<void> {
		console.log("Nucleotext: loading plugin");

		await this.loadData_();
		this.addSettingTab(new NucleotextSettingTab(this.app, this));

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
	}

	onunload(): void {
		console.log("Nucleotext: unloading plugin");
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
	}

	private async saveData_(): Promise<void> {
		const data: NucleotextData = {
			settings: this.settings,
			mapping: this.mapping,
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
