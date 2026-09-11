# Keeping this fork in sync with upstream

This fork (`jamubc/Deepseek-Harness-for-VS-Code-ENGLISH`) adds English to
`Vithrive/Deepseek-Harness-for-VS-Code`. All English lives in `l10n/` plus a handful
of `t()` call sites, so staying current with upstream is a mechanical four-step
process rather than a re-translation.

## One-time setup

```bash
git remote add upstream https://github.com/Vithrive/Deepseek-Harness-for-VS-Code.git
git fetch upstream
```

## Routine update

```bash
git fetch upstream
git merge upstream/main          # expect conflicts in package.json only
npm run l10n:manifest            # tokenize any new/changed manifest strings
npm run l10n:check               # fails loudly, listing every untranslated string
npm test
```

`npm run l10n:check` is the important step. It exits non-zero and prints each string
that has no English translation yet, in one of three categories:

| Message | What it means | Fix |
| --- | --- | --- |
| `line N: Chinese string bypasses t()` | upstream added a user-facing string that never goes through `t()` | wrap it: `t('<Chinese>')` |
| `line N: no entry in l10n/bundle.l10n.json for: "…"` | the string is wrapped but not translated | add `"<Chinese>": "<English>"` to `l10n/bundle.l10n.json` |
| `package.json <path> still carries raw Chinese` | upstream added or changed a setting/command string | add a path entry to `l10n/manifest.nls.json`, then `npm run l10n:manifest` |

Warnings (which do not fail the build) report the opposite drift: dictionary entries
for strings upstream has since removed or reworded. Delete those, or update the key
if the wording changed only slightly.

## Resolving a `package.json` conflict

The manifest is the one file that genuinely conflicts, because this fork replaces
English-carrying strings with `%key%` tokens. The resolution is always the same:

1. Take upstream's side for the conflicting region — its Chinese text and any new
   settings or commands are the source of truth.
2. Make sure the new strings are translated in `l10n/manifest.nls.json`.
3. Run `npm run l10n:manifest`. It re-tokenizes `package.json` and regenerates
   `package.nls.json` for you.

Do not hand-edit `%key%` tokens: `scripts/l10n-sync-manifest.js` owns them.

## Why not just translate the source in place?

Because it would put every future upstream edit into conflict. Instead, upstream's
Chinese literals are kept **byte-identical** in `extension.js` and used as
translation *keys*:

```js
vscode.window.showInformationMessage(t('已转发到 DSH 对话框'));
//                                          └── key ──┘  English: "Forwarded to the DSH composer."
```

If upstream rewords that message, git merges the new Chinese cleanly — it looks like
an edit to a key — and `npm run l10n:check` then reports the one entry you need to
re-translate. Nothing else moves.

The same idea applies to comments: they are translated in place, because upstream
rarely touches them and a conflict there is trivial to resolve.

## Why the language pack is hand-rolled

VS Code's built-in extension localization cannot do this job on its own.
`ExtHostLocalizationService.getMessage` short-circuits on the default UI language:

```ts
if (this.isDefaultLanguage) { return format2(message, args); }  // bundle never loads
const str = this.bundleCache.get(extensionId)?.contents[key];
return format2(str ?? message, args);                           // fallback = source string
```

On an English VS Code `isDefaultLanguage` is true, so `l10n/bundle.l10n.<lang>.json`
is never even read — and when it *is* read, a missing key falls back to the source
string, which upstream writes in Chinese. A plain `bundle.l10n` setup would therefore
still show Chinese to English users.

Manifest strings are different: `findMessageBundles` always uses `package.nls.json`
as the base bundle, so `%key%` tokens in `package.json` *do* localize correctly on
every UI language. That is why this fork uses both mechanisms:

- `package.nls.json` — resolved by VS Code at scan time; drives the Extensions view,
  the Settings UI and the Command Palette.
- `l10n.js` + `l10n/bundle.l10n.json` — an always-on dictionary consulted by `t()`,
  which additionally patches the manifest copy handed to `activate()`.

`l10n/bundle.l10n.json` is deliberately a plain `<Chinese>: <English>` map. If you
later ship real translations for other languages, add
`l10n/bundle.l10n.<lang>.json` and `vscode.l10n` will prefer it — `t()` calls
`vscode.l10n.t` first and only falls back to the base dictionary.

## Guard rails

| Command | Purpose |
| --- | --- |
| `npm run l10n:check` | fails if any user-facing Chinese is untranslated |
| `npm run l10n:manifest` | re-tokenizes `package.json`, regenerates `package.nls.json` |
| `npm run l10n:verify-comments` | proves a comment-only pass changed no code |
| `npm test` | runs `test/*.test.js`, including `test/l10n.test.js` |

`scripts/verify-comment-only.js` compares the current file against a git revision
after stripping comments *and* blanking string bodies. If the residue is identical,
no identifier, literal or operator was touched. Use it after any bulk comment edit:

```bash
git stash && git commit -am "wip" # or just compare against a known-good ref
npm run l10n:verify-comments
```

## Review checklist for a sync PR

- [ ] `npm run l10n:check` exits 0
- [ ] `npm test` passes (ignore `e2e-real-dsh.test.js`, which needs a real `dsh`)
- [ ] no Chinese left in `README.md`
- [ ] `README.zh-CN.md` refreshed if upstream's README changed materially
- [ ] `l10n/bundle.l10n.json` has no stale keys
- [ ] `package.nls.json` regenerated, not hand-edited
