import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
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
	encodeText,
	HuffmanMapping,
	isPrefixFree,
	UnknownCharacterError,
} from "./src/huffman";

interface NucleotextData {
	settings: NucleotextSettings;
	/** Persisted encoder mapping; null until the user builds one. */
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
	}

	onunload(): void {
		console.log("Nucleotext: unloading plugin");
	}

	/** Wrap command bodies so a thrown error becomes a clear Notice, never a crash. */
	private async runCommand(body: () => Promise<void>): Promise<void> {
		try {
			await body();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("Nucleotext:", e);
			new Notice(`Nucleotext error: ${msg}`);
		}
	}

	// --- Stage 3: frequency table -------------------------------------------

	private async debugFrequencyTable(): Promise<void> {
		const result = await this.scan();
		const table = result.frequencyTable;
		const distinct = distinctCount(table);
		const total = totalCount(table);

		const rows = Object.entries(table)
			.sort((a, b) => b[1] - a[1])
			.map(
				([ch, n]) =>
					`${describeChar(ch).padEnd(20)} ${n
						.toString()
						.padStart(8)}  ${((n / total) * 100).toFixed(2)}%`
			);

		console.log(
			[
				"Nucleotext frequency table",
				`  files included: ${result.filesIncluded}`,
				`  files excluded: ${result.filesExcluded}`,
				`  files failed:   ${result.filesFailed.length}`,
				`  distinct chars: ${distinct}`,
				`  total chars:    ${total}`,
				"  ----------------------------------------",
				...rows,
			].join("\n")
		);

		if (result.filesFailed.length > 0) {
			console.warn(
				"Nucleotext: files that failed to read:",
				result.filesFailed
			);
		}

		await this.writeDebugFile("frequency-table-debug.json", {
			...result,
			frequencyTable: table,
		});

		new Notice(
			`Nucleotext: ${distinct} distinct chars across ${total} chars ` +
				`(${result.filesIncluded} files). See console + plugin folder.`
		);
	}

	// --- Stage 4: build encoder + encode ------------------------------------

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
				`Internal error: mapping is not prefix-free (${describeChar(
					conflict.a
				)} vs ${describeChar(conflict.b)}).`
			);
		}

		this.mapping = mapping;
		await this.saveData_();

		const codeRows = Object.entries(mapping.codes)
			.sort((a, b) => a[1].length - b[1].length)
			.map(([ch, code]) => `${describeChar(ch).padEnd(20)} ${code}`);

		console.log(
			[
				"Nucleotext encoder built (4-ary Huffman)",
				`  alphabet size:  ${distinctCount(table)}`,
				`  prefix-free:    yes (verified)`,
				"  ----------------------------------------",
				...codeRows,
			].join("\n")
		);

		await this.writeDebugFile("encoder-mapping.json", mapping);

		new Notice(
			`Nucleotext: encoder built for ${distinctCount(table)} chars and saved. ` +
				`See console + plugin folder.`
		);
	}

	private async encodeCurrentNote(): Promise<void> {
		if (!this.mapping) {
			new Notice(
				'Nucleotext: no encoder yet. Run "Build encoder from vault" first.'
			);
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("Nucleotext: no active note to encode.");
			return;
		}

		const text = await this.app.vault.cachedRead(file);

		try {
			const sequence = encodeText(text, this.mapping);
			console.log(
				`Nucleotext encoded "${file.path}" (${text.length} chars -> ` +
					`${sequence.length} bases):\n${sequence}`
			);
			await this.writeDebugFile("last-encoded.json", {
				path: file.path,
				chars: text.length,
				bases: sequence.length,
				sequence,
			});
			new Notice(
				`Nucleotext: encoded ${text.length} chars into ${sequence.length} bases. See console.`
			);
		} catch (e) {
			if (e instanceof UnknownCharacterError) {
				new Notice(
					`Nucleotext: this note uses ${e.unknownChars.length} character(s) ` +
						`not in the encoder. Rebuild the encoder to include them.`
				);
				console.warn("Nucleotext: unknown characters:", e.unknownChars);
				return;
			}
			throw e;
		}
	}

	// --- shared helpers ------------------------------------------------------

	private scan() {
		return scanVault(this.app, this.settings.excludedFolders);
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
	}
}
