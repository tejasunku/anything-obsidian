# Obsidian to Anything LLM Plugin

This plugin syncs files from your Obsidian vault to your Anything LLM instance.

## Configuration

To use this plugin, you need to configure it with an API token and the root URL of your Anything LLM instance.

1.  Open your Anything LLM instance.
2.  Go to `Settings` > `Developer Options`.
3.  Generate a new API Key.
4.  Copy the API key.
5.  Open Obsidian and go to `Settings`.
6.  Find "Anything Obsidian Plugin" in the `Community Plugins` section.
7.  Paste your Anything LLM API key into the "API Key" field.
8.  Enter the URL for your Anything LLM instance in the "Anything LLM Root URL" field (e.g., `http://localhost:3001`).
9.  Test the connection to ensure the API key and URL are correct.

## How to use

1.  **Discover Workspaces**: In the plugin settings, click the "Discover" button to fetch all available workspaces from your Anything LLM instance.
2.  **Select Workspaces**: In the "Send To" section, toggle the workspaces you want to send files to. You can select one or more workspaces.
3.  **Upload a File**:
    - Open the file you want to upload in Obsidian.
    - Open the command palette (Ctrl+P or Cmd+P).
    - Search for and select the "Upload active file to Anything LLM" command.
    - A notification will appear confirming the success or failure of the upload.

## Manually installing the plugin

- Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/your-plugin-id/`.
