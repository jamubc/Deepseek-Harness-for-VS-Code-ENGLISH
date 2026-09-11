# Translation glossary (zh-CN → en)

This file is the single source of truth for how Chinese terms in the upstream
[Vithrive/Deepseek-Harness-for-VS-Code](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code)
project are rendered in English in this fork.

**Rule:** every entry in `l10n/bundle.l10n.json` and `l10n/manifest.nls.json` must
follow this glossary. When you add a new translated string, add any new term here
first so future upstream merges stay consistent.

## Product and component names

| Chinese | English | Notes |
| --- | --- | --- |
| DeepSeek Harness / DSH | DeepSeek Harness / DSH | Never translate. Keep as-is. |
| dsh | `dsh` | The CLI command. Keep lowercase, always in code font when prose. |
| dsh web | `dsh web` | Sub-command. Keep as-is. |
| 忠实窗口 | faithful window | The embedded-GUI mode. |
| 面板 | panel | The sidebar/tab webview. |
| 侧边栏 | sidebar | |
| 辅助侧边栏 | secondary sidebar | |
| 标签页 | tab | Editor tab. |
| 对话框 | composer | DSH's message composer — *not* "dialog box". |
| 工作区 | workspace | |
| 会话 | session | |
| 提问 | prompt | A user prompt. |
| 回答 | answer | |
| 产地标记 | provenance marker | The `⏳ …` marker written into Copilot transcripts. |
| 档位 | effort level | Reasoning effort. |
| 桥接 | bridge | The Copilot Chat bridge feature. |

## Feature and setting terms

| Chinese | English |
| --- | --- |
| 自动检测 | auto-detect |
| 自动启动 | auto-start |
| 自动安装 | auto-install |
| 工作区自动对接 | automatic workspace registration |
| 刷新 | Refresh |
| 重启 | Restart |
| 推理档位 | reasoning effort |
| 模型提供方 | model provider |
| 模型注册表 | model registry |
| 会话映射 | session mapping |
| 续聊 | continue session |
| 新会话 | new session |
| 受管认证代理 | managed auth proxy |
| 启动令牌 | launch token |
| 浏览器认证 | browser authentication |
| 端口转发 | port forwarding |
| 远程支持 | remote support |
| 剪贴板快捷键 | clipboard shortcuts |
| 跨源 iframe | cross-origin iframe |
| 发送选中内容 | Send Selection |
| 拖放 | drag and drop |
| 文件引用 | file reference |
| 光标处 | at the caret |

## Status and message vocabulary

| Chinese | English |
| --- | --- |
| 未安装 dsh | dsh not installed |
| 未连接 | Not connected |
| 无法加载 | Failed to load |
| 启动失败 | Startup failed |
| 正在重启 | Restarting |
| 等待认证 | Waiting for authentication |
| 重启失败 | Restart failed |
| 已认证 | Authenticated |
| 未认证 | Not authenticated |
| 已注册（模型选择器可见） | Registered (visible in the model picker) |
| 未注册 | Not registered |
| 跟随 DSH 默认 | Follow DSH default |
| 是 / 否 | yes / no |
| 正在启动 DeepSeek Harness… | Starting DeepSeek Harness… |
| 无法连接 DeepSeek Harness | Cannot connect to DeepSeek Harness |
| 已在标签页中打开 | is open in a tab |
| 即将完成… | Almost done… |

## Style rules

1. **English sentence case** for messages and labels, and for prose generally:
   "Send selection to composer", not "Send Selection To Composer".
2. **Command palette titles** are the exception: they use the
   `DeepSeek Harness: <Action>` form with Title Case actions, matching the upstream
   `DeepSeek Harness: <动作>` shape —
   `DeepSeek Harness: Send Selection to Composer`. These titles live in
   `l10n/manifest.nls.json`, not in `extension.js`.
3. Keep VS Code's own terminology: *Command Palette*, *Settings*, *Extensions view*.
4. Do not translate the contents of `【…】` markers *as markers* — but the English
   rendering of each specific marker is fixed here. See the protocol table below.
5. Prefer the serial ("Oxford") comma in lists of three or more.
6. Avoid marketing tone in error messages; state the cause, then the action.
7. Every user-facing string must be written as `t('<upstream Chinese>')`. Run
   `npm run l10n:check` — it fails the build if any Chinese string bypasses `t()`,
   if a dictionary entry is missing, or if a `{0}` placeholder was dropped.
8. **`Cookie` vs `cookie`.** Capitalize when naming the HTTP header as a noun
   ("inject `Host`/`Cookie`", "the `Cookie` is bound to the request `Host`").
   Lowercase for the generic plural and for local variables ("exchange cookies",
   "auth probe with no cookie"). Variable names in quoted code stay lowercase.
9. **`mutually exclusive`** is the fixed rendering of 互斥 — do not vary it with
   "block each other" or "mutual exclusion", which read as describing a different
   problem than the one the code works around.
10. Comments state what the code does and why; do not add information, examples, or
    opinions that the upstream Chinese did not contain.
11. Where an upstream comment is factually wrong about its own code, translate it so
    that it describes what the code actually does — an accurate comment in the wrong
    language is still wrong — and record the change in the commit message so the
    divergence from upstream is traceable. Example: the `fetchSessionHistory` docs
    said the cursor is probed "with 0", while the code probes with
    `MAX_SAFE_INTEGER`; the translation says "a deliberately out-of-range
    `throughSeq`".

## Protocol strings — translate in lockstep

These Chinese literals are **protocol**, not prose: they are written into and parsed
back out of Copilot chat transcripts and DSH session files. Translating them in
`extension.js` without translating the dictionary key at the same time will silently
break session matching.

| Constant | Upstream Chinese | English |
| --- | --- | --- |
| user message prefix | `用户：` | `User: ` |
| assistant message prefix | `助手：` | `Assistant: ` |
| file reference block | `【文件引用】` | `[File references]` |
| Copilot memory block | `【Copilot 记忆】` | `[Copilot memory]` |
| foreign answer label | `【Copilot 其他模型回答】` | `[Answer from another Copilot model] ` |
| submission marker | `⏳ 已提交给 DeepSeek Harness` | `⏳ Submitted to DeepSeek Harness` |

## Untranslatable on purpose

Do **not** translate these even though they contain Chinese:

- `.git/**`, `LICENSE`, `media/*.png`.
- `package.json` `repository.url` and other machine-read fields.
- The `【…】` literals in `extension.js` **code** — they are keys, and they must stay
  byte-identical to upstream so `git merge upstream/main` keeps working. Only the
  English values in `l10n/` change.
- The three DSH session-file markers listed in `ALLOWED_UNTRANSLATED` inside
  `scripts/l10n-check.js`, which match text written by dsh itself.

Everything else is translated:
`extension.js` (strings **and** comments), `package.json`, `README.md`, and
`test/**`. The Chinese originals of the prose files are kept alongside:
`README.zh-CN.md` for the README. `extension.js` keeps upstream's Chinese *strings*
by design — they are the translation keys — but its comments are English.
