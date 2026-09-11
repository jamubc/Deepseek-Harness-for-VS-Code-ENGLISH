#!/usr/bin/env node
'use strict';

/**
 * Manifest localization sync.
 *
 * Keeps `package.json` in sync with `l10n/manifest.nls.json` so this fork keeps
 * merging cleanly from upstream while every manifest string is shown in English.
 *
 * For each string in `package.json` that still holds raw Chinese it:
 *   1. looks the string up in `l10n/manifest.nls.json`, keyed by a stable path
 *      (e.g. `configuration.properties.dshPanel.url.description`);
 *   2. rewrites the value in `package.json` to a `%<path>%` token;
 *   3. writes `package.nls.json` mapping every token to its English text.
 *
 * Why tokens *and* the runtime patch in `l10n.js`? VS Code resolves
 * `package.nls.json` while *scanning* the extension, before any code runs, and that
 * is what the Extensions view, the Settings UI and the Command Palette read — so the
 * manifest needs the token form. The runtime patch additionally covers the manifest
 * copy that VS Code hands to `activate()`.
 *
 * Path rules
 * ----------
 * Paths are relative to `contributes`, with these special cases:
 *   · `description` addresses the manifest root;
 *   · contributed commands are keyed by command id, not array index, so reordering
 *     them upstream cannot point a translation at the wrong entry;
 *   · settings keys themselves contain dots (`"dshPanel.url"`), so a segment is
 *     matched by longest key first — otherwise `dshPanel.url` would be parsed as
 *     `dshPanel` then `url`, which does not exist.
 *
 * Run modes:
 *   node scripts/l10n-sync-manifest.js --check   report only; exit 1 if work pending
 *   node scripts/l10n-sync-manifest.js --write   rewrite package.json + package.nls.json
 *
 * After `git merge upstream/main`, run `--check`: a newly added upstream setting or
 * command shows up as a missing translation, which you then add to the table.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const NLS = path.join(ROOT, 'package.nls.json');
const TABLE = path.join(ROOT, 'l10n', 'manifest.nls.json');

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const doWrite = process.argv.includes('--write');

/**
 * Join a path prefix and a part.
 * @param {string} prefix
 * @param {string} part
 * @returns {string}
 */
function join(prefix, part) {
  return prefix ? prefix + '.' + part : part;
}

/**
 * Collect every Chinese string under `contributes`, with a stable path.
 * @param {Record<string, any>} pkg
 * @returns {{path: string, value: string}[]}
 */
function collectChinese(pkg) {
  const hits = [];
  const walk = (node, prefix) => {
    if (typeof node === 'string') {
      if (CJK.test(node)) hits.push({ path: prefix, value: node });
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        // A contributed command is identified by its own `command` field.
        const id = item && typeof item === 'object' && typeof item.command === 'string' ? item.command : null;
        walk(item, id ? join(prefix, id) : join(prefix, String(i)));
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], join(prefix, k));
    }
  };
  walk(pkg.contributes, '');
  if (typeof pkg.description === 'string' && CJK.test(pkg.description)) {
    hits.push({ path: 'description', value: pkg.description });
  }
  return hits;
}

/**
 * Walk one segment of a path, preferring the longest key that actually exists.
 *
 * This is what makes `configuration.properties.dshPanel.url.description` work even
 * though the real key is `"dshPanel.url"`: at each container we try the longest
 * remaining dotted prefix first, so `dshPanel.url` wins over `dshPanel`.
 *
 * @param {Record<string, any>} node
 * @param {string[]} parts remaining path segments
 * @returns {{node: Record<string, any>, key: string}|null}
 */
function descend(node, parts) {
  if (!node || typeof node !== 'object' || !parts.length) return null;

  if (Array.isArray(node)) {
    // An array of contributions. Its elements are identified by a stable field —
    // contributed commands carry `command` — so find the element whose id is a
    // prefix of the remaining path, then descend with the id consumed.
    for (let take = parts.length; take >= 1; take--) {
      const id = parts.slice(0, take).join('.');
      const el = node.find((x) => x && typeof x === 'object' && x.command === id);
      if (!el) continue;
      const rest = parts.slice(take);
      if (!rest.length) return null;
      const hit = descend(el, rest);
      if (hit) return hit;
    }
    // Fall back to a numeric index, the form the manifest uses positionally.
    const idx = Number(parts[0]);
    if (Number.isInteger(idx) && idx >= 0 && idx < node.length) {
      const rest = parts.slice(1);
      if (rest.length) return descend(node[idx], rest);
    }
    return null;
  }

  // Objects: try the longest remaining dotted prefix first, because settings keys
  // themselves contain dots (the real key is "dshPanel.url", not "dshPanel"+"url").
  for (let take = parts.length; take >= 1; take--) {
    const candidate = parts.slice(0, take).join('.');
    if (!(candidate in node)) continue;
    if (take === parts.length) return { node, key: candidate };
    const rest = descend(node[candidate], parts.slice(take));
    if (rest) return rest;
  }
  return null;
}

/**
 * Resolve a manifest path to the container and key that hold the value.
 * @param {Record<string, any>} pkg
 * @param {string} dotted
 * @returns {{node: Record<string, any>, key: string}|null}
 */
function resolve(pkg, dotted) {
  if (dotted === 'description') return { node: pkg, key: 'description' };
  if (!pkg.contributes || typeof pkg.contributes !== 'object') return null;
  return descend(pkg.contributes, String(dotted).split('.'));
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const table = JSON.parse(fs.readFileSync(TABLE, 'utf8'));

  const pending = collectChinese(pkg);
  const missing = pending.filter((h) => typeof table[h.path] !== 'string');

  if (missing.length) {
    console.error('Missing English entries in l10n/manifest.nls.json:');
    for (const h of missing) {
      console.error('  ' + h.path);
      console.error('      ' + JSON.stringify(h.value.slice(0, 110)));
    }
    console.error('\nAdd each path -> English string to l10n/manifest.nls.json, then re-run.');
    process.exit(1);
  }

  if (!pending.length) {
    console.log('package.json: every manifest string already uses a %key% token.');
  } else {
    console.log('package.json: ' + pending.length + ' string(s) to tokenize.');
  }

  if (!doWrite) {
    console.log('\nDry run. Re-run with --write to update package.json and package.nls.json.');
    return;
  }

  // Apply every edit, then write once — so a failure cannot leave a half-written file.
  for (const hit of pending) {
    const found = resolve(pkg, hit.path);
    if (!found) throw new Error('path not present in the manifest: ' + hit.path);
    if (!(found.key in found.node)) throw new Error('path not present in the manifest: ' + hit.path);
    found.node[found.key] = '%' + hit.path + '%';
  }

  const nextPkg = JSON.stringify(pkg, null, 2) + '\n';
  JSON.parse(nextPkg); // fail loudly rather than write a corrupt manifest
  fs.writeFileSync(PKG, nextPkg);

  const nls = {};
  for (const key of Object.keys(table)) {
    if (typeof table[key] === 'string') nls[key] = table[key];
  }
  fs.writeFileSync(NLS, JSON.stringify(nls, null, 2) + '\n');

  console.log('\nWrote package.json and package.nls.json (' + Object.keys(nls).length + ' entries).');
}

main();
