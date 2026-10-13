<div align="center">

# DeepSeek Pilot

**A browser extension for DeepSeek with project management, cross-chat memory, and long-conversation continuation.**

[简体中文](README.md) · English

![Version](https://img.shields.io/badge/version-0.9.0-blue) ![Platform](https://img.shields.io/badge/platform-Chrome_MV3-4285F4) ![Status](https://img.shields.io/badge/status-early_development-orange)

[Project status](#project-status) · [Installation](#installation)

</div>

DeepSeek Pilot is an independently developed third-party extension, not affiliated with DeepSeek.

## Project status

The current version is **0.9.0, an early development release**, with these capabilities implemented:

| Module | Available today |
| --- | --- |
| Project management | Project tree, manual chat assignment, pins, archives and new chats within projects |
| Cross-chat memory | Separate personal and project memories, with applicable context included in the first message of a new chat |
| Memory management | Categorized viewing and editing, pinned entries, import/export, personal memory compression and local snapshots |
| Conversation continuation | Switch to a new chat at the configured context budget and include applicable memory |
| Task management | Serial queue, pause, failure notices, retries and draft preservation |
| Cleanup protection | Distinguish generated auxiliary chats from manually collected chats; protect unknown-origin chats and chats linked to running tasks |

Automatic classification is currently disabled; assign chats manually. Memory is included only in the first message of regular chats. Project memory also requires a selected project and the switch enabled beforehand; enabling it later does not inject it retroactively. Display switches affect visibility, not memory transmission or learning.

Periodic settings refreshes preserve text selections in unchanged content. Memory processing checks the page every 5 seconds and checks history completion at most once every 30 seconds. It keeps waiting while generation is active or content changes, and reports a stall only after 10 minutes without generation, content progress or confirmed completion. Auxiliary chats are registered as plugin chats when first identified so they do not trigger repeated processing of regular chats.

## Installation

### Option 1: Download ZIP (recommended)

Open the [repository](https://github.com/5J-5J/DeepSeek-Pilot), choose **Code → Download ZIP**, and extract it to a permanent folder. Installation currently uses unpacked source; no build is needed.

### Option 2: Clone with Git

```sh
git clone https://github.com/5J-5J/DeepSeek-Pilot.git deepseek-pilot
cd deepseek-pilot
```

### Load in Chrome

1. Confirm that the extracted or cloned folder contains `core/manifest.json`.
2. Open `chrome://extensions/` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's **`core/`** folder.
4. Open or refresh [DeepSeek](https://chat.deepseek.com/) and sign in with your own account.
5. Create a project, describe its goal and move related chats into it. Inspect or maintain memories in the memory manager.
6. Start a new chat inside the project and check the project-memory switch before sending its first message.

No build step or separate model API key is required. Memory processing and other automation use auxiliary DeepSeek web conversations, require a working account and network, and generate site requests. The extension UI is currently in Chinese.

### Update an existing installation

For a Git installation, run `git pull --ff-only` in the repository. For ZIP installations, extract the updated source into the original location. Then reload **DeepSeek Pilot** in `chrome://extensions/` and refresh the DeepSeek page. Keep the loaded folder in place. Export important memories before updating; uninstalling the extension is not necessary.

If Chrome cannot find the manifest, select the `core/` folder containing `manifest.json`, not the ZIP file or repository root.

### Usage notes

Memories and synchronized data are stored locally, but injection, processing and compression send relevant content to DeepSeek. The extension retains the latest 10 generated auxiliary chats and deletes eligible older ones from DeepSeek; manually collected chats are protected. Deleting a project does not delete remote chats. Clearing extension data removes local memories and snapshots.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification instructions. No open-source license has been selected for this repository yet.
