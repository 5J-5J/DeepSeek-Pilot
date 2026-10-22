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
| Project management | Project tree, always-visible new-project and settings buttons, manual chat assignment, pins, archives and new chats within projects |
| Cross-chat memory | Separate personal and project memories, with applicable context included in the first message of a new chat |
| Memory management | Categorized viewing and editing, pinned entries, import/export, personal memory compression and local snapshots |
| Conversation continuation | Switch to a new chat at the configured context budget and include applicable memory |
| Task management | Serial queue, pause, failure notices, retries and draft preservation |
| Cleanup protection | Distinguish generated auxiliary chats from manually collected chats; protect unknown-origin chats and chats linked to running tasks |

Automatic classification is currently disabled; assign chats manually. Memory is included only in the first message of regular chats. Project memory also requires a selected project and the switch enabled beforehand; enabling it later does not inject it retroactively. New chats never force a project selection; without one they send normally under the personal-memory rule. A message with only attachments and no text is sent natively without memory injection. Chat display settings separately control personal memory, project memory, token/timestamp rows in project chats, and the sidebar automation group; the latter two are enabled by default. Display switches affect visibility, not memory transmission or learning. For attachments sent with text, attachment cards remain intact while timestamps, token counts and memory visibility match the message body.

The sidebar's automation group starts collapsed whenever the page opens and shows the latest five chats when expanded. Regular chats outside projects are grouped under “未归类会话” (Unassigned conversations). The display limit does not change retention or cleanup rules.

The sidebar follows DeepSeek's current conversation list and uses locally saved conversation IDs to attach project assignments. Chats deleted while the extension was disabled do not reappear from old caches; new IDs appear under Unassigned conversations. Use “加载更多会话” (Load more conversations) to fetch older official pages. Unloaded chats keep their project assignments, and history caches used for memory processing and continuation do not add sidebar entries. Newly created chats appear as soon as creation is confirmed, without reloading the page.

Personal memory prioritizes lasting preferences, response style and collaboration habits. Events are retained only when they matter to long-term life, work or future collaboration, summarized in one or two sentences about the key outcome rather than everyday details or full accounts. Later processing and compression also review existing unpinned event entries; user-pinned entries remain protected.

Memory is automatically processed after each completed reply, including the latest chat. Only chats confirmed by the current official list with complete, new or changed history are processed; unchanged chats are not processed again.

With project memory enabled, reaching the context budget sends the current question, applicable memories and recent progress to a successor chat in the same project. The matching original draft is cleared only after receipt is confirmed. While waiting, the extension checks the successor's history and reports a heartbeat every 30 seconds; the task ends only when the reply is explicitly finished. Uncertain outcomes retain the original input for review.

Periodic settings refreshes preserve text selections in unchanged content. Memory processing obtains the auxiliary chat ID from the actual outgoing request and checks the page every 5 seconds. When that page changes from generating to no longer generating, it immediately checks history and submits the memory-processing result only after the reply is confirmed as `FINISHED`. History polling every 30 seconds remains as a fallback, even without visible answer text. It keeps waiting while generation is active or content changes, and reports a stall only after 10 minutes without generation, content progress or confirmed completion, including the target chat and latest history-read error. Auxiliary chats are registered as plugin chats when first identified so they do not trigger repeated processing of regular chats.

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

### Load in Firefox

1. Use **Firefox 128 or newer** and open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on** and select **`firefox/manifest.json`**, rather than the Chrome manifest in `core/`.
3. Open or refresh DeepSeek. If site access is not granted, allow the extension to access `chat.deepseek.com` in the extension menu.

The complete `firefox/` directory is included; no build is required. Reload the temporary add-on after restarting Firefox. The fixed extension ID preserves its identity, but export important memories as a backup. Browser data is separate; use memory export/import to migrate. Permanent installation in standard Firefox requires a Mozilla-signed XPI, which this repository does not currently provide.

After updating, click **Reload** on the debugging page and refresh DeepSeek. This version uses an event background and Firefox Promise APIs. Offline fixtures have been checked; real-account behavior has not been verified in Firefox.

### Update an existing installation

For a Git installation, run `git pull --ff-only` in the repository. For ZIP installations, extract the updated source into the original location. Then reload **DeepSeek Pilot** in `chrome://extensions/` and refresh the DeepSeek page. Keep the loaded folder in place. Export important memories before updating; uninstalling the extension is not necessary.

If Chrome cannot find the manifest, select the `core/` folder containing `manifest.json`, not the ZIP file or repository root.

### Usage notes

Memories and synchronized data are stored locally, but injection, processing and compression send relevant content to DeepSeek. The extension retains the latest 10 generated auxiliary chats and deletes eligible older ones from DeepSeek; manually collected chats are protected. Locally, completed jobs older than 30 days, timing metrics older than 90 days, and messages/memberships of deleted chats older than 7 days are pruned automatically. Deleting a project does not delete remote chats. Clearing extension data removes local memories and snapshots.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and verification instructions. No open-source license has been selected for this repository yet.
