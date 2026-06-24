import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

interface NucleotextSettings {
	// Settings will be populated in later stages (e.g. excluded folders,
	// homopolymer run length, GC target). Kept empty for the scaffold stage.
}

const DEFAULT_SETTINGS: NucleotextSettings = {};

export default class NucleotextPlugin extends Plugin {
	settings: NucleotextSettings;

	async onload(): Promise<void> {
		console.log("Nucleotext: loading plugin");

		await this.loadSettings();

		this.addSettingTab(new NucleotextSettingTab(this.app, this));
	}

	onunload(): void {
		console.log("Nucleotext: unloading plugin");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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
			.setDesc(
				"Encoder settings will appear here as later stages are built."
			)
			.setHeading();
	}
}
