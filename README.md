# DeepSeek Harness for VS Code

A zero-dependency VS Code extension that brings **DeepSeek Harness (DSH)** into VS Code in two forms:

1. **Faithful window**: embeds the DSH web GUI as-is in a VS Code sidebar, secondary sidebar, or editor tab, and auto-detects and starts the DSH service — no script injection, no UI rewriting, and no interaction interception, so nothing you do to organize DSH's pages, assemble third-party plugins, or otherwise extend it is affected;
2. **Copilot bridge (since v0.7.13, early release)**: registers DSH as a VS Code chat model — entries such as **DSH (DeepSeek Harness), DeepSeek-V4-Pro (DSH), DeepSeek-V4-Flash (DSH), and deepseek-v4-flash-vision-exp (DSH)** appear in the model picker; select one and you can solve problems in Copilot Chat using DSH's powerful task orchestration and tool calling.

> **The Copilot bridge does not affect the "faithful window" mode** — it is only a convenience feature for easier coding; as long as you do not select these model entries, everything behaves exactly as it would without the bridge.

> **About this repository (English fork).** This is the English edition of the upstream
> project. All English lives in a small in-repo language pack (`l10n/`, plus `l10n.js` and
> a handful of `t()` calls), so upstream's own text is kept byte-identical as translation
> keys and routine upstream updates stay a mechanical merge — a scheduled workflow does
> the merge daily and only asks for help when upstream adds new strings.
>
> Maintaining this fork? **[docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md)** covers the
> sync, and [TERMINOLOGY.md](TERMINOLOGY.md) records the translation decisions.

## ⚡ Install the English build

1. Download `deepseek-harness-vscode-english-<version>.vsix` from
   [Releases](https://github.com/jamubc/Deepseek-Harness-for-VS-Code-ENGLISH/releases/latest).
2. Install it, either from the terminal:

   ```bash
    code --install-extension deepseek-harness-vscode-english-<version>.vsix
   ```

   or in VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file.
3. `Ctrl+Shift+P` → **Developer: Reload Window**.

The panel, its buttons, the error pages, every setting and the Copilot model picker are
English from that point on — the extension does not depend on your VS Code display
language. When you open the panel, the extension auto-detects and starts DSH (if it is
not installed, the extension prompts you and runs `npm install -g @deepseek-ai/dsh` on
your behalf).

To build the `.vsix` yourself instead, no tooling is required beyond Node:

```bash
npm run package         # writes dist/deepseek-harness-vscode-english-<version>.vsix
npm run install:vsix   # installs it with the code CLI
```

If you like this extension, please star [Deepseek-Harness-for-VS-Code](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code); if you need a Chrome extension, take a look at [Deepseek-Harness-for-Chrome](https://github.com/Vithrive/Deepseek-Harness-for-Chrome).

> **Version compatibility**: **from v0.8.34**, this extension supports **dsh v0.1.2-rc.1 and later** — it automatically completes the web browser authentication added in that dsh version (the extension's managed auth proxy keeps the panel and the Copilot bridge free of logins and interruptions throughout; see "dsh web browser authentication" below). It is also **backward compatible** with older dsh versions that do not enable authentication (launch-flag detection, and automatic fallback between the old and new RPC endpoint formats).

## 🙏 Acknowledgements

- [Pelapis](https://github.com/Pelapis) — contributed the macOS panel clipboard shortcut fix and iterated to converge its scope (built-in plugin `dsh-webview-clipboard`, PRs #11 and #14).
- [curtainsmall](https://github.com/curtainsmall) — fixed whole-page blur when the panel iframe is scaled by a non-integer factor (switched to CSS zoom, PR #10).
- [anupamme](https://github.com/anupamme) — reported the workspace settings injection surface, which drove hardening of the child-process invocation (PR #12).

---

---

## 🪟 Faithful window (panel)

- Embeds the DSH web GUI as-is in the sidebar, the secondary sidebar, or an **editor tab** (the tab can be pinned; it automatically yields to the sidebar's "single active view" rule, working around the DSH front end's single-instance limitation in webviews);
- **Auto-detects, auto-starts, and auto-installs** dsh, and renders only once the service is ready, so you never see a blank screen;
- **Automatic workspace registration**: starts dsh with the current VS Code workspace and registers it in the DSH workspace list (idempotent; it does not override the selection you made manually in DSH);
- **Remote support**: under Remote-SSH or Dev Containers it runs on the server side, auto-detects and installs the server-side dsh, and connects the panel to your local VS Code through port forwarding;
- Panel buttons: Refresh (does not interrupt a running task) / Restart dsh web / Open in browser; the font size scales proportionally with `editor.fontSize` (implemented with CSS zoom, so non-integer scaling stays sharp);
- **Send Selection / drag and drop files into the DSH composer** (auto-installs the companion plugin `dsh-drop-caret`): inserts files, folders, and code snippets as `path:line` references exactly at the composer's caret; clicking an external link in a DSH conversation opens it in the system browser (together with the DSH plugin `dsh-open-links`).
- **macOS clipboard shortcut fix (auto-installs the companion plugin `dsh-webview-clipboard`)**: fixes ⌘C/⌘V/⌘X not working inside the panel on macOS — when the DSH page is embedded in a webview as a cross-origin iframe, the browser's native default clipboard action never fires. The plugin injects into the DSH page, intercepts these three keys, and performs them explicitly through execCommand. It is active only on macOS when embedded; behavior everywhere else is unchanged.

### Example: sending the selection to the composer

Drag and drop and the context-menu send are the most-used features of `dsh-drop-caret`. Here is how they work:

1. In VS Code, **select a code block or a block of text**;
2. **Right-click** and choose **"DeepSeek Harness: Send Selection to Composer"**:

   ![Context menu: Send selection to composer](media/send-selection-menu.png)
3. A link to the code block's line range (`path:startLine-endLine`) is sent to the composer and inserted at the current caret position:

   ![The result appears in the DSH composer](media/send-selection-result.png)
4. Then just send the message in DSH; the model can use the reference to locate the exact file and line numbers of the code block.

> Likewise, you can **drag files or folders directly into** the composer from your system file manager or the VS Code Explorer; the insertion point is again the caret position corresponding to the drop point.

### Panel settings

| Setting | Default | Description |
| --- | --- | --- |
| `dshPanel.url` | `http://127.0.0.1:3080` | The DSH address the panel connects to |
| `dshPanel.host` / `dshPanel.port` | `127.0.0.1` / `3080` | Host and port to bind when auto-starting |
| `dshPanel.autoStart` | `true` | Whether to auto-start dsh when it is not running |
| `dshPanel.autoRegisterWorkspace` | `true` | Whether to register the current workspace as a DSH workspace automatically |
| `dshPanel.autoInstallDsh` | `true` | Whether to prompt and install on your behalf when dsh is not installed |
| `dshPanel.dshCommand` | `dsh` | The dsh command (a full path is allowed) |
| `dshPanel.killOnDispose` | `true` | Whether to stop the dsh instance this extension started when the extension is deactivated |
| `dshPanel.openSystemBrowser` | `false` | Whether to keep the old behavior of popping up the system browser when the extension starts dsh |
| `dshPanel.installClipboardPlugin` | `true` | Auto-install the built-in `dsh-webview-clipboard` plugin (fixes editing shortcuts inside the macOS panel; on Windows and Linux it is an inert file that does not affect behavior). Turn it off to compare if you suspect it affects `dsh web` startup |

### dsh web browser authentication (since v0.8.35, automatic, no action required)

Starting with dsh `0.1.2-rc`, the web GUI enables browser authentication: every `dsh web` launch generates a one-time "process launch token" and prints an authentication link of the form `dsh web: http://127.0.0.1:3080/?token=…`; opening that link in a browser exchanges it for a signed cookie, and requests afterwards use that cookie, while a bare address always returns 401. In addition, `/api` has a browser trust fence (the Host must be loopback, the Origin must match the Host, and cross-site requests are rejected).

How the extension handles this (**without disabling any of dsh's security mechanisms, and invisibly to you**):

- When the extension starts dsh, it captures the authentication link printed on stdout and starts a **managed auth proxy** on a random `127.0.0.1` port: the proxy performs the token → cookie exchange, then injects credentials into every forwarded request (pages, APIs, and WebSockets), so the panel and the Copilot bridge both go through the proxy;
- The token is cached in VS Code global state: in other windows, or after reloading VS Code, authentication stays silent as long as the dsh instance has not changed;
- `--no-open` is appended by default when starting dsh, so the system browser no longer pops up (enable `dshPanel.openSystemBrowser` if you want the old behavior);
- If dsh was **started outside this extension** (so its token is unavailable), the first time you open the panel you are prompted once with a choice: "Restart and authenticate automatically (recommended)", which lets the extension take over dsh and restores full silence afterwards, or paste the entire authentication link printed as `dsh web:` in your terminal;
- The "Open in browser" button carries the current token automatically, so the system browser can exchange its own cookie normally;
- The proxy is not enabled for Remote or non-loopback addresses (authentication must be completed once in a browser on the machine running dsh), so behavior matches earlier versions.

### Compatibility with older dsh versions (no authentication)

The extension remains fully compatible with older dsh versions that do not enable web authentication; every fallback path is automatic and invisible:

- **Launch flags**: `--no-open` is probed first with `dsh web --help` and omitted on older versions that do not support it (so an unknown flag never causes a startup failure);
- **Authentication path**: the home page status is probed before the panel loads — when an older version returns 200 (no authentication), the original direct path is used and no proxy injection is enabled; prompts such as "Restart and authenticate automatically" appear only when a 401 is detected;
- **RPC endpoints**: the extension requests the new slash endpoints (`workspace/create`, and so on) and falls back automatically to the old dotted endpoints (`workspace.create`) on a 404; when `session/page` is unavailable it falls back to `session.history`;
- **Waiting for a full start**: the `dsh web:` printed line is the readiness signal (both old and new versions print it); the rare very old version that never prints it is remembered (`dsh.quietBoot`) and is not waited for again.

### Remote server (vscode-server) scenarios

The extension declares `extensionKind: ["workspace"]`, so under Remote-SSH, Dev Containers, and similar setups it runs on the server side:

1. It auto-detects and installs the server-side dsh (`npm install -g @deepseek-ai/dsh`; Node.js and npm must already be installed on the server);
2. Automatic port forwarding: `vscode.env.asExternalUri` exposes the remote `127.0.0.1:3080` locally, so the iframe loads directly with no manual SSH tunnel (just allow the first forwarding confirmation);
3. dsh starts with the remote workspace as its cwd and is registered automatically.

If DSH runs on another machine and you are not connected through VS Code Remote, you can set up a tunnel manually: `ssh -L 3080:127.0.0.1:3080 user@server`, and set `dshPanel.autoStart` to `false`.

---

## 🧭 Copilot bridge: user guide

### Quick start

1. Open the Chat panel (`Ctrl+Alt+I`) and choose **DSH (DeepSeek Harness)** from the model picker (`Ctrl+Alt+.`) — or pick a fixed entry such as **DeepSeek-V4-Pro (DSH)** directly;
2. Ask a question directly, for example "analyze this project's data for me" — DSH uses its configured model to run tasks in the workspace and call tools to solve the problem, and the answer is **streamed back** into the chat view;
3. Each Copilot chat maps to one DSH session: **a new chat creates a new DSH session automatically, and follow-up prompts in the same chat reuse that session**; you can watch the full execution live in the DSH panel.

### Models and reasoning effort

- **Model**: the `DSH (DeepSeek Harness)` entry follows the default model in DSH settings (`agent-default-model`); you can also pin one with `dshPanel.chatProvider` / `dshPanel.chatModel` (for example `deepseek-official` / `deepseek-v4-pro`; configure the matching provider in DSH settings first). Entries such as **DeepSeek-V4-Pro (DSH)** in the model picker always map to the corresponding official DeepSeek model.
- **Reasoning effort (`reasoningEffort`)**: choose it in the model configuration of the chat UI (off / low / high / max; it takes effect in sync with the DSH session); `dshPanel.dshReasoningEffort` is the fallback setting.

### Switching to another model and back

If you switch a Copilot session to another custom model mid-conversation and then switch back to a DSH model, the extension **labels the intermediate turns produced by the other model with a provenance marker and forwards them to the DSH session**; content DSH answered itself is never sent back again (saving tokens and context) — the timeline on the DSH side stays complete.

### Common commands

| Command | What it does |
| --- | --- |
| `DeepSeek Harness: Reset DSH Session Mapping` | Clears the chat → DSH session mapping; the next prompt creates a brand-new DSH session |
| `DeepSeek Harness: Check DSH Status` | Shows whether DSH is reachable, whether the model provider is registered, and the current model configuration |
| `DeepSeek Harness: Diagnose DSH Model Registry` | Exports model registry diagnostics (for troubleshooting) |

> Cancelling the wait does not kill the DSH task: the task keeps running in DSH, and you can watch it in the panel.

### Bridge settings

| Setting | Default | Description |
| --- | --- | --- |
| `dshPanel.enableDshModel` | `true` | Whether to register the DSH chat model entries (turning this off disables the bridge; the panel is unaffected) |
| `dshPanel.chatProvider` / `dshPanel.chatModel` | empty | The provider / model used by the `DSH (DeepSeek Harness)` entry (for example `deepseek-official` / `deepseek-v4-pro`); leave empty to follow the DSH default |
| `dshPanel.chatAgentPreset` | empty | The agent preset used when creating a DSH session (for example `liangshen`); empty = DSH default |
| `dshPanel.dshReasoningEffort` | empty | Reasoning effort fallback: off / low / high / max; the UI selection wins |
| `dshPanel.chatTimeoutMs` | `900000` | Maximum wait per task in milliseconds (15 minutes); after a timeout the task still runs in the DSH panel |
| `dshPanel.chatSyncLookbackMin` | `60` | Chat session file scan window (minutes) |
| `dshPanel.debugModelMessages` | `false` | Debugging: write the message structures VS Code sends to the model into `.dsh-debug/` |

---

## 🧩 Copilot bridge: how it works

Overall data flow:

```
Copilot Chat (the conversation VS Code has assembled)
        │  language model provider protocol (vscode.lm.registerLanguageModelChatProvider)
        ▼
This extension (the dsh provider)
  1. Strip the noise: remove system prompts, tool definitions, and environment/context wrappers (<prompt>/<userRequest>/<instructions>…),
     keeping only the real question-and-answer turns and the body of Copilot memory
  2. Session mapping: key on the Copilot chat's sessionId and map it to a DSH session (one chat, one session)
  3. Incremental sync: send DSH only what it has not seen yet (its own answers are never sent back; other models' turns are forwarded with a provenance marker)
  4. Effort sync: pass the reasoningEffort chosen in the UI to DSH (session.selectModel)
        │  session.create / session.prompt / session.history (DSH RPC)
        ▼
DSH: reorganizes everything with its own harness (memory / skills / AGENTS.md / tools / agent presets) and hands it to the configured model
        │  streaming events (text-delta)
        ▼
This extension: streams the answer back into the Copilot chat view incrementally
```

Key points:

- **Stripping the noise**: every message VS Code hands to the model may wrap `<instructions>` (.copilot/instructions and AGENTS.md references), the real prompt in `<prompt>`, `<userMemory>/<sessionMemory>` blocks, and so on. The extension extracts only the real prompt and the body of the memory — context assembly is left to DSH's own harness, so the two harnesses never interfere with each other.
- **Session mapping (sessionId mapped directly)**: each Copilot chat has a unique file on disk at `workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl` (the file name is the sessionId). The extension keys on `m-<sessionId>` to build a one-to-one chat → DSH session mapping:
  - After the first turn: it claims the chat file when "the last prompt in the file equals the previous prompt in the current transcript" (the previous turn is always already on disk, so there is no race and no waiting);
  - First turn: a new chat file holds only metadata at that point, so the "empty chat file created within the last 60 seconds" is taken as the current chat;
  - It works across Windows, macOS, and Linux and across the different user data directories of vscode-server (Remote-SSH, WSL, and Dev Containers), and it prefers a match in the current workspace;
  - Fallback: in the rare cases such as a write-to-disk race, it falls back to a hash of the first prompt and validates against the transcript to prevent crossed wires.
- **Incremental sync (saves tokens)**: a DSH session already replays what it has answered, so the extension sends only "what was added after the last DSH answer" — in a continuous conversation it sends just the new prompt; after switching away and back, outside turns are forwarded with an `[Answer from another Copilot model]` label.
- **Double-delivery deduplication**: VS Code delivers the same prompt twice (the bare prompt plus one with context); the extension recognizes them as the same question, runs it once, and replays the same answer on the other path.
- **Concurrency support**: when several chats use the DSH model at the same time, each chat is located independently, gets its own session, and returns in parallel; startup probing and file parsing are memoized and cached so concurrent chats do not slow each other down.

---

## 🌱 Release status

The Copilot bridge is an **early release**, but it has been thoroughly tested and is **fully functional**:

- You are welcome to try it on different operating systems (Windows, macOS, and Linux, as well as remote setups such as Remote-SSH, WSL, and Dev Containers);
- If you run into problems, please report them in [GitHub Issues](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/issues); the author will respond and improve things as soon as possible;
- To repeat: **the Copilot bridge does not affect the "faithful window" mode** — the panel always renders the DSH web GUI faithfully, injecting nothing into, rewriting nothing in, and intercepting nothing on the page, and it does not interfere with your plugin development or UI customization for DSH.

---

## 🔧 Install from source (development mode)

This extension is pure JavaScript: it needs no npm install and no build step:

```bash
git clone https://github.com/jamubc/Deepseek-Harness-for-VS-Code-ENGLISH.git
code Deepseek-Harness-for-VS-Code-ENGLISH
```

Press `F5` in VS Code to open an Extension Development Host window, then open your project folder in it. To package and install it yourself:

```bash
npx --yes @vscode/vsce package --allow-missing-repository
code --install-extension deepseek-harness-vscode-english-<version>.vsix
```

## Prerequisites and known limitations

- **Prerequisites**: DeepSeek Harness is installed (either a global install with `npm install -g @deepseek-ai/dsh` or `npx @deepseek-ai/dsh`; the extension recognizes both, and you can also give a full path through `dshPanel.dshCommand`); by default DSH response headers set neither `X-Frame-Options` nor a strict CSP, so it can be embedded in an iframe normally.
- **Known limitation**: the DSH front end degrades to a singleton when several VS Code webview instances exist (opening several copies in a normal browser works fine; this is a DSH front-end implementation issue), so a tab and a sidebar cannot load DSH at the same time for now; the extension works around this with a "single active view" policy (opening the tab makes the sidebar yield automatically and show a placeholder, and it recovers on its own once the tab is closed).
