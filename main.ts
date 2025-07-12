import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

interface Workspace {
	name: string;
	slug: string;
}

interface AnythingObsidianSettings {
	apiKey: string;
	rootUrl: string;
	workspaces: Workspace[];
	selectedWorkspaces: string[];
}

const DEFAULT_SETTINGS: AnythingObsidianSettings = {
	apiKey: '',
	rootUrl: 'http://localhost:3001',
	workspaces: [],
	selectedWorkspaces: []
}

export default class AnythingObsidian extends Plugin {
	settings: AnythingObsidianSettings;

	async onload() {
		await this.loadSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AnythingObsidianSettingTab(this.app, this));

		this.addCommand({
			id: 'upload-active-file-to-anything-llm',
			name: 'Upload active file to Anything LLM',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const { selectedWorkspaces, apiKey, rootUrl } = this.settings;

				if (!selectedWorkspaces || selectedWorkspaces.length === 0) {
					new Notice('No workspace selected. Please select a workspace in the plugin settings.');
					return;
				}

				if (!apiKey || !rootUrl) {
					new Notice('API Key or Root URL is missing. Please configure them in the settings.');
					return;
				}
				
				const file = view.file;
				if (!file) {
					new Notice('No active file to upload.');
					return;
				}

				const fileContent = await this.app.vault.read(file);
				
				const formData = new FormData();
				formData.append('file', new Blob([fileContent], { type: 'text/markdown' }), file.name);
				formData.append('addToWorkspaces', selectedWorkspaces.join(','));

				new Notice(`Uploading ${file.name}...`);

				try {
					// We need to use fetch directly as requestUrl does not support FormData well.
					const response = await fetch(`${rootUrl}/api/v1/document/upload`, {
						method: 'POST',
						body: formData,
						headers: {
							'Authorization': `Bearer ${apiKey}`,
						}
					});
					
					const responseData = await response.json();

					if (responseData.success) {
						new Notice(`${file.name} uploaded successfully to ${selectedWorkspaces.length} workspace(s).`);
					} else {
						new Notice(`Failed to upload ${file.name}. Error: ${responseData.error}`);
					}
				} catch (e: any) {
					new Notice(`Error uploading file: ${e.message}`);
					console.error(e);
				}
			}
		});
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

		new Setting(containerEl)
			.setName('Anything LLM Root URL')
			.setDesc('Enter your Anything LLM instance URL')
			.addText(text => text
				.setPlaceholder('http://localhost:3001')
				.setValue(this.plugin.settings.rootUrl)
				.onChange(async (value) => {
					if (value.endsWith('/')) {
						value = value.slice(0, -1);
					}
					this.plugin.settings.rootUrl = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Test API Key')
			.setDesc('Click to test your API key and connection to Anything LLM.')
			.addButton(button => button
				.setButtonText('Test Connection')
				.onClick(async () => {
					if (!this.plugin.settings.apiKey || !this.plugin.settings.rootUrl) {
						new Notice('Please enter an API Key and Root URL first.');
						return;
					}

					try {
						const response = await requestUrl({
							url: `${this.plugin.settings.rootUrl}/api/v1/auth`,
							method: 'GET',
							headers: {
								'Accept': 'application/json',
								'Authorization': `Bearer ${this.plugin.settings.apiKey}`
							}
						});

						if (response.status === 200 && response.json.authenticated) {
							new Notice('API Key is valid!');
						} else {
							new Notice('API Key is invalid or connection failed.');
						}
					} catch (e) {
						new Notice('Error connecting to Anything LLM. Check the Root URL and your network connection.');
						console.error(e);
					}
				}));

		new Setting(containerEl)
			.setName('Discover Workspaces')
			.setDesc('Click to fetch available workspaces from your Anything LLM instance.')
			.addButton(button => button
				.setButtonText('Discover')
				.onClick(async () => {
					if (!this.plugin.settings.apiKey || !this.plugin.settings.rootUrl) {
						new Notice('Please enter an API Key and Root URL first.');
						return;
					}
					try {
						const response = await requestUrl({
							url: `${this.plugin.settings.rootUrl}/api/v1/workspaces`,
							method: 'GET',
							headers: {
								'Accept': 'application/json',
								'Authorization': `Bearer ${this.plugin.settings.apiKey}`
							}
						});

						if (response.status === 200) {
							const data = response.json;
							const newWorkspaces = data.workspaces.map((ws: { name: string, slug: string }) => ({
								name: ws.name,
								slug: ws.slug
							}));
							this.plugin.settings.workspaces = newWorkspaces;
							
							const newWorkspaceSlugs = new Set(newWorkspaces.map((ws: Workspace) => ws.slug));
							this.plugin.settings.selectedWorkspaces = this.plugin.settings.selectedWorkspaces.filter(slug => newWorkspaceSlugs.has(slug));

							await this.plugin.saveSettings();
							new Notice(`${data.workspaces.length} workspaces found.`);
							this.display(); // Rerender
						} else {
							new Notice('Failed to fetch workspaces.');
						}
					} catch (e) {
						new Notice('Error fetching workspaces.');
						console.error(e);
					}
				}));

		if (this.plugin.settings.workspaces && this.plugin.settings.workspaces.length > 0) {
			containerEl.createEl('h2', { text: 'Send To' });
			containerEl.createEl('p', { text: 'Select the workspaces to send files to.' });

			this.plugin.settings.workspaces.forEach((ws: Workspace) => {
				new Setting(containerEl)
					.setName(ws.name)
					.addToggle(toggle => toggle
						.setValue(this.plugin.settings.selectedWorkspaces.includes(ws.slug))
						.onChange(async (value) => {
							const { selectedWorkspaces } = this.plugin.settings;
							if (value) {
								if (!selectedWorkspaces.includes(ws.slug)) {
									selectedWorkspaces.push(ws.slug);
								}
							} else {
								const index = selectedWorkspaces.indexOf(ws.slug);
								if (index > -1) {
									selectedWorkspaces.splice(index, 1);
								}
							}
							this.plugin.settings.selectedWorkspaces = selectedWorkspaces;
							await this.plugin.saveSettings();
						}));
			});
		}
	}
}
