import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

interface AnythingObsidianSettings {
	apiKey: string;
}

const DEFAULT_SETTINGS: AnythingObsidianSettings = {
	apiKey: ''
}

export default class AnythingObsidian extends Plugin {
	settings: AnythingObsidianSettings;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AnythingObsidianSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AnythingObsidianSettingTab extends PluginSettingTab {
	plugin: AnythingObsidian;

	constructor(app: App, plugin: AnythingObsidian) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Anything LLM API Key')
			.setDesc('Enter your Anything LLM API Key')
			.addText(text => text
				.setPlaceholder('Enter your API Key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
