'use strict';

/**
 * In-repo language pack for the DeepSeek Harness VS Code extension.
 *
 * Why this exists instead of plain `vscode.l10n` bundles
 * ------------------------------------------------------
 * VS Code's own extension-localization support cannot make this extension
 * English on its own. `ExtHostLocalizationService.getMessage` short-circuits on
 * the default language:
 *
 *     getMessage(extensionId, details) {
 *         const { message, args, comment } = details;
 *         if (this.isDefaultLanguage) { return format2(message, (args ?? {})); }   // bundle never loads
 *         ...
 *         const str = this.bundleCache.get(extensionId)?.contents[key];
 *         return format2(str ?? message, (args ?? {}));                            // fallback = source string
 *     }
 *
 * `isDefaultLanguage` is true on an English VS Code, so `l10n/bundle.l10n.<lang>.json`
 * is never even read, and when it *is* read the fallback is the source string.
 * Upstream's source strings are Chinese, so a pure bundle.l10n approach would
 * still show Chinese to English users.
 *
 * The manifest side is different and does work: `package.nls.json` is always the
 * base message bundle (`findMessageBundles`), so `%key%` placeholders in
 * `package.json` are resolved for every UI language.
 *
 * Design goals
 * ------------
 * 1. English must be correct on every VS Code UI language, including plain `en`.
 * 2. `git merge upstream/main` must stay clean, so upstream's Chinese literals are
 *    kept verbatim in `extension.js` and used as *translation keys*. English lives
 *    only in `l10n/bundle.l10n.json`.
 * 3. Newly added upstream strings must never crash or silently vanish; they degrade
 *    to a loud, greppable marker that `npm run l10n:check` reports.
 *
 * @module l10n
 */

const fs = require('fs');
const path = require('path');

/** Bundle file holding `"<Chinese source string>": "<English>"` pairs. */
const BUNDLE_FILE = path.join(__dirname, 'l10n', 'bundle.l10n.json');

/**
 * Marker wrapped around keys that have no translation yet. Deliberately loud and
 * non-ASCII-free so it is obvious both in the UI and in a grep.
 * @param {string} key
 * @returns {string}
 */
function untranslated(key) {
  return '\u27e8' + 'untranslated: ' + key + '\u27e9';
}

/**
 * Load the translation bundle. A missing or corrupt file is not fatal: the
 * extension still works and simply reports untranslated strings.
 * @returns {Record<string, string>}
 */
function loadBundle() {
  try {
    const raw = fs.readFileSync(BUNDLE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (e) {
    try {
      console.error('[DeepSeek Harness] failed to load l10n bundle:', e && e.message);
    } catch (_) { /* logging must never break activation */ }
  }
  return {};
}

/** @type {Record<string, string>} */
const bundle = loadBundle();

/**
 * Same key convention as `@vscode/l10n-dev` and `ExtHostLocalizationService`:
 * a comment, when present, is appended to the message with a `/` separator.
 * @param {string} message
 * @param {string|string[]} [comment]
 * @returns {string}
 */
function bundleKey(message, comment) {
  if (!comment || comment.length === 0) return message;
  return message + '/' + (Array.isArray(comment) ? comment.join('') : comment);
}

/**
 * Substitute `{0}`-style positional and `{name}`-style named placeholders.
 * Mirrors VS Code's internal `format2` so the output is identical whether a string
 * came from `vscode.l10n` or from this module's own fallback dictionary.
 * @param {string} template
 * @param {Array<string|number>|Record<string, any>|undefined} args
 * @returns {string}
 */
function format2(template, args) {
  let out = String(template);
  if (args === undefined || args === null) return out;
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      out = out.replace(new RegExp('\\{' + i + '\\}', 'g'), String(args[i]));
    }
    return out;
  }
  if (typeof args === 'object') {
    for (const k of Object.keys(args)) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(args[k]));
    }
  }
  return out;
}

/**
 * Translate a user-facing string.
 *
 * Accepts the same three call shapes as `vscode.l10n.t`:
 *
 *     t('无法连接 DeepSeek Harness')
 *     t('已提交给 DeepSeek Harness（{0}）', [model])
 *     t({ message: '…', args: [...], comment: '…' })
 *
 * Resolution order:
 *   1. `vscode.l10n.t` — if a language pack actually installed a translation for a
 *      non-default UI language, prefer it (so third-party translations still work).
 *   2. `l10n/bundle.l10n.json` — this repo's always-on English dictionary.
 *   3. `untranslated(key)` — loud marker; `scripts/l10n-check.js` fails the build on it.
 *
 * @param {string|{message: string, args?: any, comment?: string|string[]}} message
 * @param {Array<string|number>|Record<string, any>} [args]
 * @param {string|string[]} [comment]
 * @returns {string}
 */
function t(message, args, comment) {
  let msg = message;
  let a = args;
  let c = comment;
  if (message && typeof message === 'object') {
    msg = message.message;
    a = message.args;
    c = message.comment;
  }
  if (typeof msg !== 'string') return String(msg);

  const key = bundleKey(msg, c);

  // 1. Let a real language pack win when one is installed for this UI language.
  const vscode = safeVscode();
  if (vscode && vscode.l10n && typeof vscode.l10n.t === 'function') {
    try {
      const viaVscode = vscode.l10n.t(message, ...(Array.isArray(a) ? a : a === undefined ? [] : [a]));
      // `getMessage` returns the source string itself when nothing was found, so a
      // result equal to the source means "no language-pack translation".
      if (viaVscode && viaVscode !== msg) return viaVscode;
    } catch (_) { /* fall through to the local dictionary */ }
  }

  // 2. This repo's dictionary.
  let text = bundle[key];
  if (typeof text !== 'string') text = bundle[msg];

  // 3. Nothing matched.
  if (typeof text !== 'string') return format2(untranslated(msg), a);

  return format2(text, a);
}

/**
 * `require('vscode')` when running inside the extension host, otherwise null.
 * Kept lazy so `test/*.js` can load this module under a plain `vscode` stub.
 * @returns {any}
 */
function safeVscode() {
  try {
    return require('vscode');
  } catch (_) {
    return null;
  }
}

/**
 * Dotted-key translation table for `package.json`. Keys are paths inside the
 * manifest, for example `commands.dshPanel.refresh.title`.
 * Loaded from `l10n/manifest.nls.json`; also consumed by `package.nls.json`
 * generation (see `scripts/l10n-check.js --manifest`).
 * @returns {Record<string, any>}
 */
function manifestTranslations() {
  try {
    const file = path.join(__dirname, 'l10n', 'manifest.nls.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* optional file */ }
  return {};
}

/**
 * Resolve a dotted manifest path to the container and key holding the value.
 *
 * Paths are relative to `contributes` and have to cope with two awkward facts:
 *   · settings keys themselves contain dots — the real key is `"dshPanel.autoStart"`,
 *     not `dshPanel` then `autoStart` — so the longest matching key wins;
 *   · `contributes.commands` is an array whose elements are identified by
 *     `command`, so it is matched by id rather than by index.
 *
 * @param {Record<string, any>} manifest
 * @param {string} dotted
 * @returns {{node: Record<string, any>, key: string}|null}
 */
function resolveManifestPath(manifest, dotted) {
  const dottedPath = String(dotted);
  // The table's paths are relative to `contributes`, except `description`, which
  // addresses the manifest root — that is how l10n-sync-manifest.js generates them.
  if (dottedPath === 'description') {
    return manifest && typeof manifest === 'object' ? { node: manifest, key: 'description' } : null;
  }
  if (!manifest || typeof manifest !== 'object' || !manifest.contributes) return null;
  const parts = dottedPath.split('.');

  /** @type {{node: Record<string, any>, key: string}|null} */
  const descend = (node, rest) => {
    if (!node || typeof node !== 'object' || !rest.length) return null;

    if (Array.isArray(node)) {
      for (let take = rest.length; take >= 1; take--) {
        const id = rest.slice(0, take).join('.');
        const el = node.find((x) => x && typeof x === 'object' && x.command === id);
        if (!el) continue;
        const tail = rest.slice(take);
        if (!tail.length) return null;
        const hit = descend(el, tail);
        if (hit) return hit;
      }
      const idx = Number(rest[0]);
      if (Number.isInteger(idx) && idx >= 0 && idx < node.length && rest.length > 1) {
        return descend(node[idx], rest.slice(1));
      }
      return null;
    }

    for (let take = rest.length; take >= 1; take--) {
      const candidate = rest.slice(0, take).join('.');
      if (!(candidate in node)) continue;
      if (take === rest.length) return { node, key: candidate };
      const hit = descend(node[candidate], rest.slice(take));
      if (hit) return hit;
    }
    return null;
  };

  if (!parts.length) return null;
  return descend(manifest.contributes, parts);
}

/**
 * Read a dotted manifest path, or `undefined` when absent.
 * @param {Record<string, any>} manifest
 * @param {string} dotted
 * @returns {any}
 */
function getPath(manifest, dotted) {
  const found = resolveManifestPath(manifest, dotted);
  return found ? found.node[found.key] : undefined;
}

/**
 * Write a dotted manifest path. Returns false when the path does not exist, so a
 * stale translation entry can never invent a new manifest field.
 * @param {Record<string, any>} manifest
 * @param {string} dotted
 * @param {any} value
 * @returns {boolean}
 */
function setPath(manifest, dotted, value) {
  const found = resolveManifestPath(manifest, dotted);
  if (!found) return false;
  found.node[found.key] = value;
  return true;
}

/**
 * Apply English translations on top of the manifest VS Code hands to `activate()`.
 *
 * This is a belt-and-braces layer next to `package.nls.json`. The nls file is what
 * the *Extensions view* and *Settings UI* use (VS Code resolves it at scan time,
 * before activation), but the extension host receives the raw `package.json`
 * through `ExtensionContext.extension.packageJSON`. Both paths are covered so no
 * Chinese reaches either UI.
 *
 * @param {Record<string, any>} manifest `context.extension.packageJSON`
 * @returns {Record<string, any>} the same object, with English applied in place
 */
function applyManifestTranslations(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const table = manifestTranslations();
  for (const dotted of Object.keys(table)) {
    const value = table[dotted];
    if (typeof value !== 'string') continue;
    // Only overwrite something that exists; a stale key must not invent entries.
    if (getPath(manifest, dotted) === undefined) continue;
    setPath(manifest, dotted, value);
  }
  return manifest;
}

/**
 * The English text actually used for the `⏳ Submitted to…` marker.
 * Exported so tests can assert the protocol strings stay in lockstep.
 * @param {string} source upstream Chinese literal
 * @returns {string}
 */
function protocolText(source) {
  return t(source);
}

/**
 * A snapshot of the loaded bundle, for the l10n coverage checker.
 * @returns {Record<string, string>}
 */
function bundleSnapshot() {
  return Object.assign(Object.create(null), bundle);
}

/** i18n entry point, in the `t` shape but with an explicit bundle path. */
const BUNDLE_PATH = BUNDLE_FILE;

module.exports = {
  t,
  format2,
  untranslated,
  applyManifestTranslations,
  manifestTranslations,
  protocolText,
  bundleSnapshot,
  BUNDLE_PATH
};
