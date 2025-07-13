import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile } from 'obsidian';

interface Workspace {
	name: string;
	slug: string;
}

interface AnythingObsidianSettings {
	apiKey: string;
	rootUrl: string;
	workspaces: Workspace[];
	selectedWorkspaces: string[];
	syncedFolders: string[];
	autoDelete: boolean;
	updateHandling: 'keep-in-workspace' | 'archive' | 'delete';
	remoteBaseFolder: string;
	autoSync: boolean;
	autoSyncInterval: number;
	showNotifications: boolean;
}

const DEFAULT_SETTINGS: AnythingObsidianSettings = {
	apiKey: '',
	rootUrl: 'http://localhost:3001',
	workspaces: [],
	selectedWorkspaces: [],
	syncedFolders: [],
	autoDelete: false,
	updateHandling: 'archive',
	remoteBaseFolder: 'Obsidian Vault',
	autoSync: false,
	autoSyncInterval: 5,
	showNotifications: true,
}

export default class AnythingObsidian extends Plugin {
	settings: AnythingObsidianSettings;
	autoSyncIntervalId: number | null = null;

	async onload() {
		await this.loadSettings();
		this.applyAutoSyncSettings();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new AnythingObsidianSettingTab(this.app, this));

		this.addCommand({
			id: 'sync-folders-to-anything-llm',
			name: 'Sync folders to Anything LLM',
			callback: async () => {
				this.notify('Sync process initiated...');
				await this.syncFolders();
			}
		});

		this.addCommand({
			id: 'upload-active-file-to-anything-llm',
			name: 'Upload active file to Anything LLM',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const { selectedWorkspaces, apiKey, rootUrl } = this.settings;

				if (!selectedWorkspaces || selectedWorkspaces.length === 0) {
					this.notify('No workspace selected. Please select a workspace in the plugin settings.');
					return;
				}

				if (!apiKey || !rootUrl) {
					this.notify('API Key or Root URL is missing. Please configure them in the settings.');
					return;
				}

				const file = view.file;
				if (!file) {
					this.notify('No active file to upload.');
					return;
				}
				this.notify(`Uploading ${file.name}...`);
				await this.uploadFile(file, selectedWorkspaces);
			}
		});
	}

	async syncFolders() {
		const { apiKey, rootUrl, syncedFolders, remoteBaseFolder } = this.settings;
		if (!syncedFolders || syncedFolders.length === 0) {
			this.notify('No folders configured for syncing.');
			return;
		}

		await this.ensureRemoteFolderExists(remoteBaseFolder);

		this.notify('Fetching remote file list...');
		const remoteFiles = await this.getRemoteFileList();
		if (remoteFiles === null) {
			this.notify('Failed to fetch remote files. Aborting sync.');
			return;
		}

		this.notify('Scanning local files...');
		const localFiles = await this.getLocalFiles(syncedFolders);
		
		const { toCreate, toUpdate, toDelete } = this.compareFiles(localFiles, remoteFiles);

		console.log('Files to create:', toCreate);
		console.log('Files to update:', toUpdate);
		console.log('Files to delete:', toDelete);

		this.notify('Sync comparison complete. Check console for details.');

		// Now, perform the actual file operations
		await this.processCreations(toCreate, localFiles);
		await this.processUpdates(toUpdate, localFiles, remoteFiles);
		await this.processDeletions(toDelete, remoteFiles);

		// Final cleanup step
		if (this.settings.autoDelete) {
			this.notify('Auto-delete is enabled, clearing remote archives...');
			await this.clearRemoteArchives();
		}
	}

	async processCreations(toCreate: Set<string>, localFiles: Map<string, any>) {
		for (const path of toCreate) {
			const file = this.app.vault.getAbstractFileByPath(localFiles.get(path).path);
			if (file instanceof TFile) {
				this.notify(`Creating: ${file.name}`);
				await this.uploadFile(file, this.settings.selectedWorkspaces);
			}
		}
	}

	async processUpdates(toUpdate: Set<string>, localFiles: Map<string, any>, remoteFiles: Map<string, any>) {
		const { updateHandling } = this.settings;
		if (toUpdate.size === 0) return;

		const filesToUpload: TFile[] = [];
		const remotePathsToModify: string[] = [];
		for (const key of toUpdate) {
			const localFile = localFiles.get(key);
			const remoteFile = remoteFiles.get(key);
			if (!localFile || !remoteFile) continue;

			filesToUpload.push(this.app.vault.getAbstractFileByPath(localFile.path) as TFile);
			remotePathsToModify.push(`${this.settings.remoteBaseFolder}/${remoteFile.name}`);
		}
		
		this.notify(`Found ${filesToUpload.length} file(s) to update.`);

		// Always upload the new version first
		for (const file of filesToUpload) {
			await this.uploadFile(file, this.settings.selectedWorkspaces);
		}

		// Now, handle the old version based on the setting
		if (updateHandling === 'keep-in-workspace') {
			// Do nothing. The old file is kept and its embeddings remain.
			this.notify('Kept old versions in workspace.');
			return;
		}

		// For both 'archive' and 'delete', we need to remove the old embeddings
		for (const slug of this.settings.selectedWorkspaces) {
			await this.removeDocumentsFromWorkspace(slug, remotePathsToModify);
		}

		if (updateHandling === 'archive') {
			// Move the old files to an archive folder
			await this.moveFilesToArchive(remotePathsToModify);
		}

		if (updateHandling === 'delete') {
			// Move the old files to the trash folder, which will be deleted if auto-delete is on
			await this.moveFilesToTrash(remotePathsToModify);
		}
	}

	async uploadFile(file: TFile, workspaces: string[]) {
		const { apiKey, rootUrl, remoteBaseFolder } = this.settings;
		
		await this.ensureRemoteFolderExists(remoteBaseFolder);
		
		const fileContent = await this.app.vault.read(file);
		const mangledName = this.getMangledFileName(file);
		
		const formData = new FormData();
		formData.append('file', new Blob([fileContent], { type: 'text/markdown' }), mangledName);

		try {
			const response = await fetch(`${rootUrl}/api/v1/document/upload/${encodeURIComponent(remoteBaseFolder)}`, {
				method: 'POST',
				body: formData,
				headers: { 'Authorization': `Bearer ${apiKey}` }
			});
			
			const responseData = await response.json();
			if (!response.ok || !responseData.success) {
				const errorMessage = responseData.error || `HTTP error! Status: ${response.status}`;
				this.notify(`Failed to upload ${file.name}: ${errorMessage}`);
				return; // Stop if upload failed
			}

			// If upload is successful, add to workspaces
			const newDocumentName = responseData.documents[0].name;
			const documentPath = `${remoteBaseFolder}/${newDocumentName}`;
			for (const slug of workspaces) {
				await this.addDocumentToWorkspace(slug, documentPath);
			}

		} catch (e: any) {
			this.notify(`Failed to upload ${file.name}.`);
		}
	}

	async addDocumentToWorkspace(slug: string, documentPath: string) {
		const { apiKey, rootUrl } = this.settings;
		try {
			await requestUrl({
				url: `${rootUrl}/api/v1/workspace/${slug}/update-embeddings`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify({
					adds: [documentPath]
				})
			});
		} catch (e: any) {
			console.error(`Failed to add ${documentPath} to workspace ${slug}:`, e);
			this.notify(`Failed to add document to workspace ${slug}.`);
		}
	}

	async moveFilesToTrash(remotePaths: string[]) {
		await this.moveFilesToFolder(remotePaths, '_trash');
	}
	
	async moveFilesToArchive(remotePaths: string[]) {
		await this.moveFilesToFolder(remotePaths, '_archive');
	}
	
	async moveFilesToFolder(remotePaths: string[], targetFolder: string) {
		if (remotePaths.length === 0) return;
		const { apiKey, rootUrl } = this.settings;
	
		const filesToMove = remotePaths.map(path => ({
			from: path,
			to: `${targetFolder}/${path.split('/').pop()}`
		}));
	
		try {
			await this.ensureRemoteFolderExists(targetFolder);
			await fetch(`${rootUrl}/api/v1/document/move-files`, {
				method: 'POST',
				body: JSON.stringify({ files: filesToMove }),
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
			});
			this.notify(`Moved ${remotePaths.length} file(s) to the ${targetFolder} folder.`);
		} catch (e: any) {
			console.error(`Error moving files to ${targetFolder}:`, e);
			this.notify(`Failed to move files to ${targetFolder}.`);
		}
	}
	
	async processDeletions(toDelete: Set<string>, remoteFiles: Map<string, any>) {
		if (toDelete.size === 0) return;
	
		const remotePathsToDelete: string[] = [];
		const { remoteBaseFolder } = this.settings;
	
		for (const key of toDelete) {
			const remoteFile = remoteFiles.get(key);
			if (!remoteFile) continue;
			const remotePath = `${remoteBaseFolder}/${remoteFile.name}`;
			remotePathsToDelete.push(remotePath);
		}
		
		this.notify(`Found ${remotePathsToDelete.length} file(s) to delete.`);
		for (const slug of this.settings.selectedWorkspaces) {
			await this.removeDocumentsFromWorkspace(slug, remotePathsToDelete);
		}
	
		await this.moveFilesToTrash(remotePathsToDelete);
	}

	async removeDocumentsFromWorkspace(slug: string, documentPaths: string[]) {
		if (documentPaths.length === 0) return;
		const { apiKey, rootUrl } = this.settings;
		try {
			await requestUrl({
				url: `${rootUrl}/api/v1/workspace/${slug}/update-embeddings`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify({
					deletes: documentPaths
				})
			});
		} catch (e: any) {
			console.error(`Failed to remove documents from workspace ${slug}:`, e);
			this.notify(`Failed to remove documents from workspace ${slug}.`);
		}
	}

	async clearRemoteArchives() {
		const { apiKey, rootUrl } = this.settings;
		const foldersToClear = ['_trash', '_archive'];
		for (const folderName of foldersToClear) {
			try {
				await fetch(`${rootUrl}/api/v1/document/remove-folder`, {
					method: 'DELETE',
					body: JSON.stringify({ name: folderName }),
					headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
				});
				this.notify(`Cleared the ${folderName} folder.`);
			} catch (e: any) {
				// It's okay if the folder doesn't exist, so we only log other errors.
				if (e.message && !e.message.includes('404')) {
					console.error(`Error clearing ${folderName} folder:`, e);
				}
			}
		}
	}

	getMangledFileName(file: TFile): string {
		return file.path.replace(/\//g, '_-_');
	}

	getRemotePathKey(mangledName: string): string {
		return `${this.settings.remoteBaseFolder}/${mangledName}`;
	}

	async getRemoteFileList(): Promise<Map<string, any> | null> {
		const { apiKey, rootUrl, remoteBaseFolder } = this.settings;
		try {
			const response = await requestUrl({
				url: `${rootUrl}/api/v1/documents/folder/${remoteBaseFolder}`,
				method: 'GET',
				headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${apiKey}` }
			});

			if (response.status === 200) {
				const fileMap = new Map<string, any>();
				for (const doc of response.json.documents) {
					const key = this.getRemotePathKey(doc.title);
					fileMap.set(key, doc);
				}
				return fileMap;
			}
			// If the folder doesn't exist, the API returns a 404, which is expected.
			// Return an empty map in this case.
			return new Map<string, any>();
		} catch (e) {
			console.error('Error fetching remote file list:', e);
			return null;
		}
	}

	async getLocalFiles(syncedFolders: string[]): Promise<Map<string, any>> {
		const localFiles = new Map<string, any>();
		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			const isInSyncedFolder = syncedFolders.some(folder => 
				folder === '.' || file.path.startsWith(folder + '/')
			);

			if (isInSyncedFolder) {
				const mangledName = this.getMangledFileName(file);
				const key = this.getRemotePathKey(mangledName);
				localFiles.set(key, {
					path: file.path,
					mtime: file.stat.mtime
				});
			}
		}
		return localFiles;
	}

	compareFiles(localFiles: Map<string, any>, remoteFiles: Map<string, any>) {
		const toCreate = new Set<string>();
		const toUpdate = new Set<string>();

		for (const [key, file] of localFiles.entries()) {
			if (!remoteFiles.has(key)) {
				toCreate.add(key);
			} else {
				const remoteFile = remoteFiles.get(key);
				const remoteMtime = new Date(remoteFile.published).getTime();
				if (file.mtime > remoteMtime) {
					toUpdate.add(key);
				}
			}
		}

		const localKeys = new Set(localFiles.keys());
		const toDelete = new Set<string>();
		for (const key of remoteFiles.keys()) {
			if (!localKeys.has(key)) {
				toDelete.add(key);
			}
		}

		return { toCreate, toUpdate, toDelete };
	}

	async ensureRemoteFolderExists(path: string): Promise<void> {
		const { apiKey, rootUrl } = this.settings;
		// This is simplified now - it doesn't need to be recursive.
		try {
			const response = await fetch(`${rootUrl}/api/v1/document/create-folder`, {
				method: 'POST',
				body: JSON.stringify({ name: path }),
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
			});
			if (!response.ok) {
				const data = await response.json();
				if (data.error && !data.error.includes('already exists')) {
					console.error(`Failed to create folder ${path}:`, data.error);
				}
			}
		} catch (e: any) {
			// Error is likely "already exists", which is fine.
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyAutoSyncSettings();
	}

	applyAutoSyncSettings() {
		if (this.autoSyncIntervalId) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}

		if (this.settings.autoSync) {
			this.autoSyncIntervalId = this.registerInterval(
				window.setInterval(() => {
					this.notify('Auto-syncing files...');
					this.syncFolders();
				}, this.settings.autoSyncInterval * 60 * 1000)
			);
		}
	}

	notify(message: string) {
		if (this.settings.showNotifications) {
			new Notice(message);
		}
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

		containerEl.createEl('h2', { text: 'General' });

		new Setting(containerEl)
			.setName('Show notifications')
			.setDesc('Enable or disable notifications for sync status and other operations.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showNotifications)
				.onChange(async (value) => {
					this.plugin.settings.showNotifications = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'Connection' });

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
						this.plugin.notify('Please enter an API Key and Root URL first.');
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
							this.plugin.notify('API Key is valid!');
						} else {
							this.plugin.notify('API Key is invalid or connection failed.');
						}
					} catch (e) {
						this.plugin.notify('Error connecting to Anything LLM. Check the Root URL and your network connection.');
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
						this.plugin.notify('Please enter an API Key and Root URL first.');
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
							this.plugin.notify(`${data.workspaces.length} workspaces found.`);
							this.display(); // Rerender
						} else {
							this.plugin.notify('Failed to fetch workspaces.');
						}
					} catch (e) {
						this.plugin.notify('Error fetching workspaces.');
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

		containerEl.createEl('h2', { text: 'Folder Sync' });

		new Setting(containerEl)
			.setName('Folders to Sync')
			.setDesc('Enter the paths of the folders you want to sync, one path per line, relative to your vault root. Use "." to sync the entire vault. For example: "Inbox" or "Projects/Active".')
			.addTextArea(text => text
				.setPlaceholder('.\nFolder1\nFolder2/Subfolder')
				.setValue(this.plugin.settings.syncedFolders.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.syncedFolders = value.split('\n').map(path => path.trim()).filter(path => path.length > 0);
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('Permanently delete archived files')
			.setDesc('If enabled, the remote trash and archive folders will be cleared after sync. If disabled, old files will be kept.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoDelete)
				.onChange(async (value) => {
					this.plugin.settings.autoDelete = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'Sync Behavior' });

		new Setting(containerEl)
			.setName('Remote Base Folder')
			.setDesc('The root folder in Anything LLM to sync your vault to.')
			.addText(text => text
				.setPlaceholder('Obsidian Vault')
				.setValue(this.plugin.settings.remoteBaseFolder)
				.onChange(async (value) => {
					this.plugin.settings.remoteBaseFolder = value;
					await this.plugin.saveSettings();
				}));
		
		new Setting(containerEl)
			.setName('When a synced file is updated...')
			.setDesc('How to handle the old version of a file in Anything LLM when it is updated in Obsidian.')
			.addDropdown(dropdown => dropdown
				.addOption('keep-in-workspace', 'Keep both versions in workspace')
				.addOption('archive', 'Replace version in workspace (archive old)')
				.addOption('delete', 'Replace completely (destructive)')
				.setValue(this.plugin.settings.updateHandling)
				.onChange(async (value: 'keep-in-workspace' | 'archive' | 'delete') => {
					this.plugin.settings.updateHandling = value;
					await this.plugin.saveSettings();
				}));
		
		containerEl.createEl('h2', { text: 'Auto Sync' });

		new Setting(containerEl)
			.setName('Enable Auto Sync')
			.setDesc('Automatically sync your specified folders in the background.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					this.display(); // Rerender to show/hide interval setting
				}));
		
		if (this.plugin.settings.autoSync) {
			new Setting(containerEl)
				.setName('Sync Interval (minutes)')
				.setDesc('How often to automatically sync your files.')
				.addText(text => text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.autoSyncInterval))
					.onChange(async (value) => {
						const interval = parseInt(value, 10);
						if (!isNaN(interval) && interval > 0) {
							this.plugin.settings.autoSyncInterval = interval;
							await this.plugin.saveSettings();
						}
					}));
		}
	}
}
