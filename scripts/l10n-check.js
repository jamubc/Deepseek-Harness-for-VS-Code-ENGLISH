#!/usr/bin/env node
'use strict';

/**
 * l10n coverage gate — run after every `git merge upstream/main`.
 *
 * It answers one question: did the merge introduce user-facing Chinese that has no
 * English translation? Exit code 1 means yes, and lists exactly what is missing.
 *
 * How it works
 * ------------
 * This is deliberately not a JavaScript parser. The codebase has one strict
 * convention that makes an exact two-step check possible:
 *
 *   Every user-facing string is written as `t('<Chinese>')` — single-quoted, with
 *   no embedded single quotes.
 *
 * Step 1 records every such call and verifies the dictionary has an entry for it.
 * Step 2 removes those verified calls from a comment-stripped copy of the file and
 * then looks for any *remaining* CJK inside a quoted string. Anything left over is
 * a Chinese string that never went through `t()`, i.e. a leak. This second step is
 * what makes the check airtight: it does not need to understand the surrounding
 * code at all, only whether a CJK message was consumed by a `t()` call.
 *
 * Usage:
 *   node scripts/l10n-check.js            # check
 *   node scripts/l10n-check.js --list     # also print every translated key
 */

const fs = require('fs');
const path = require('path');
const PATH = path;

const ROOT = path.join(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension.js');
const BUNDLE = path.join(ROOT, 'l10n', 'bundle.l10n.json');
const MANIFEST_NLS = path.join(ROOT, 'l10n', 'manifest.nls.json');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_NLS = path.join(ROOT, 'package.nls.json');
const SYNC_SCRIPT = path.join(ROOT, 'scripts', 'l10n-sync-manifest.js');

/** CJK ideographs plus CJK punctuation — the character set upstream writes in. */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Literals deliberately left in Chinese because they are protocol data, matched
 * against strings written by dsh itself. Keep this list short, with a reason each.
 */
const ALLOWED_UNTRANSLATED = new Map([
  ['用户：', 'matched against the DSH session-file format'],
  ['助手：', 'matched against the DSH session-file format'],
  ['【文件引用】', 'matched against the DSH session-file format']
]);

const errors = [];
const warnings = [];
const notes = [];

/**
 * Read and parse a JSON file, recording a readable error on failure.
 * @param {string} file
 * @param {string} label
 * @returns {any}
 */
function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(label + ' is not valid JSON: ' + e.message);
    return {};
  }
}

/**
 * Blank `//` and block comments, so comment prose cannot be mistaken for code.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * Turn a source literal body into its runtime value, so `\n` in the source matches
 * a real newline in the JSON dictionary.
 * @param {string} body
 * @returns {string}
 */
function unescapeLiteral(body) {
  return body.replace(/\\(n|r|t|0|'|"|\\)/g, (m, c) => (
    { n: '\n', r: '\r', t: '\t', 0: '\0', "'": "'", '"': '"', '\\': '\\' }[c]
  ));
}

/**
 * Step 1: find every `t('<literal>')` call.
 * @param {string} src comment-stripped source
 * @returns {{value: string, line: number, start: number, end: number}[]}
 */
function findTranslatedCalls(src) {
  const calls = [];
  // One-argument form: t('message')
  // Multi-argument form:  t('message', args) — the extra arguments must balance.
  const re = /(^|[^\w$.])t\('((?:\\.|[^'\\])*)'(\)|,)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[1].length;
    let end = start + m[0].length - m[1].length;
    if (m[3] === ',') {
      // Walk the argument list to the call's matching close parenthesis.
      let depth = 0;
      let k = src.indexOf('(', start);
      while (k < src.length) {
        const ch = src[k];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { k++; break; } }
        k++;
      }
      end = k;
    }
    calls.push({
      value: unescapeLiteral(m[2]),
      line: src.slice(0, start).split('\n').length,
      start,
      end
    });
  }
  return calls;
}

/**
 * Step 2: after removing the verified `t()` calls, is any CJK left inside a quoted
 * string? Those would be Chinese messages that bypassed translation entirely.
 * @param {string} src comment-stripped source
 * @param {{start: number, end: number}[]} calls
 * @returns {{value: string, line: number}[]}
 */
function findLeaks(src, calls) {
  const chars = src.split('');
  for (const call of calls) {
    for (let i = call.start; i < call.end; i++) chars[i] = ' ';
  }
  const residue = chars.join('');
  const leaks = [];
  const re = /'((?:\\.|[^'\\])*)'/g;
  let m;
  while ((m = re.exec(residue)) !== null) {
    const value = unescapeLiteral(m[1]);
    if (!CJK.test(value)) continue;
    if (ALLOWED_UNTRANSLATED.has(value)) {
      const line = residue.slice(0, m.index).split('\n').length;
      notes.push('allowed raw literal line ' + line + ': ' + value + ' (' + ALLOWED_UNTRANSLATED.get(value) + ')');
      continue;
    }
    leaks.push({ value, line: residue.slice(0, m.index).split('\n').length });
  }
  return leaks;
}

function main() {
  const src = stripComments(fs.readFileSync(EXTENSION, 'utf8'));
  const bundle = readJson(BUNDLE, 'l10n/bundle.l10n.json');
  const manifestNls = readJson(MANIFEST_NLS, 'l10n/manifest.nls.json');
  const pkg = readJson(PACKAGE_JSON, 'package.json');

  // ---- 1. Every translated call must have a dictionary entry --------------
  const calls = findTranslatedCalls(src);
  const usedValues = new Set();
  for (const call of calls) {
    usedValues.add(call.value);
    if (!(call.value in bundle)) {
      errors.push('line ' + call.line + ': no entry in l10n/bundle.l10n.json for: ' + JSON.stringify(call.value.slice(0, 70)));
    }
  }

  // ---- 2. No Chinese string may bypass t() --------------------------------
  for (const leak of findLeaks(src, calls)) {
    errors.push('line ' + leak.line + ': Chinese string bypasses t(): ' + JSON.stringify(leak.value.slice(0, 70)));
  }

  // ---- 3. Dictionary hygiene ----------------------------------------------
  for (const key of Object.keys(bundle)) {
    if (CJK.test(key) && !usedValues.has(key)) {
      warnings.push('l10n/bundle.l10n.json key is no longer used in extension.js: ' + JSON.stringify(key.slice(0, 70)));
    }
    const value = bundle[key];
    if (typeof value !== 'string') {
      errors.push('l10n/bundle.l10n.json value for ' + JSON.stringify(key.slice(0, 40)) + ' is not a string');
    } else if (CJK.test(value)) {
      errors.push('l10n/bundle.l10n.json value still contains Chinese: ' + JSON.stringify(value.slice(0, 60)));
    }
  }

  // ---- 4. Placeholders must survive translation ---------------------------
  const placeholderRe = /\{(\d+|[A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const entry of Object.entries(bundle)) {
    const key = entry[0];
    const value = entry[1];
    if (typeof value !== 'string') continue;
    const inKey = new Set(key.match(placeholderRe) || []);
    const inValue = new Set(value.match(placeholderRe) || []);
    for (const token of inKey) {
      if (!inValue.has(token)) {
        errors.push('placeholder ' + token + ' missing from the translation of:\n      key:   ' + JSON.stringify(key) + '\n      value: ' + JSON.stringify(value));
      }
    }
    for (const token of inValue) {
      if (!inKey.has(token)) {
        warnings.push('translation adds placeholder ' + token + ', absent from the source key:\n      key:   ' + JSON.stringify(key) + '\n      value: ' + JSON.stringify(value));
      }
    }
  }

  // ---- 5. Manifest coverage ----------------------------------------------
  const manifestHits = [];
  const walk = (node, prefix) => {
    if (typeof node === 'string') {
      if (CJK.test(node)) manifestHits.push({ path: prefix, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, prefix ? prefix + '.' + i : String(i)));
      return;
    }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], prefix ? prefix + '.' + k : k);
    }
  };
  walk(pkg, '');
  for (const hit of manifestHits) {
    errors.push('package.json ' + hit.path + ' still carries raw Chinese (expected a %key% token): ' + JSON.stringify(hit.value.slice(0, 60)));
  }
  for (const entry of Object.entries(manifestNls)) {
    if (typeof entry[1] === 'string' && CJK.test(entry[1])) {
      errors.push('l10n/manifest.nls.json ' + entry[0] + ' still contains Chinese: ' + JSON.stringify(entry[1].slice(0, 60)));
    }
  }

  // ---- 6. package.nls.json must resolve every %token% in package.json -----
  //
  // This mirrors what VS Code does at scan time: `localizeManifest` walks the whole
  // manifest and replaces any string shaped like %key% with the message bundle entry
  // for `key`. Checking it here means a missing or mistyped token is caught by CI
  // rather than showing up as a literal "%configuration.…%" in the Settings UI.
  if (!fs.existsSync(PACKAGE_NLS)) {
    errors.push('package.nls.json is missing — run: node scripts/l10n-sync-manifest.js --write');
  } else {
    const nls = readJson(PACKAGE_NLS, 'package.nls.json');
    const tokens = [];
    const scan = (node, prefix) => {
      if (typeof node === 'string') {
        if (node.length > 1 && node[0] === '%' && node.endsWith('%')) {
          tokens.push({ path: prefix, key: node.slice(1, -1) });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => scan(v, prefix ? prefix + '.' + i : String(i)));
        return;
      }
      if (node && typeof node === 'object') {
        for (const k of Object.keys(node)) scan(node[k], prefix ? prefix + '.' + k : k);
      }
    };
    scan(pkg, '');
    for (const token of tokens) {
      if (!(token.key in nls)) {
        errors.push('package.json ' + token.path + ' references %' + token.key + '%, which package.nls.json does not define');
      }
    }
    // And no entry may be left dangling, or it is dead weight after a rename.
    const referenced = new Set(tokens.map((x) => x.key));
    for (const key of Object.keys(nls)) {
      if (!referenced.has(key)) {
        warnings.push('package.nls.json defines ' + key + ', which package.json no longer references');
      }
    }

    // package.nls.json is generated from l10n/manifest.nls.json. Editing it by hand
    // silently diverges from the table — and would be overwritten by the next sync —
    // so compare the two rather than trusting them to agree.
    for (const [key, expected] of Object.entries(manifestNls)) {
      if (typeof expected !== 'string') continue;
      if (key in nls && nls[key] !== expected) {
        errors.push('package.nls.json disagrees with l10n/manifest.nls.json for ' + key +
          '\n      table:     ' + JSON.stringify(expected.slice(0, 90)) +
          '\n      generated: ' + JSON.stringify(String(nls[key]).slice(0, 90)) +
          '\n      Fix the table, then run: node scripts/l10n-sync-manifest.js --write');
      }
    }
    if (!tokens.length) errors.push('package.json contains no %token% strings; manifest sync has not run');
  }

  // ---- 7. Manifest metadata ----------------------------------------------
  //
  // VS Code rejects a manifest whose identity fields are malformed, and the identity
  // is permanent once an extension has been installed anywhere — so a mistake here is
  // expensive to undo. Checking it alongside the translations keeps one gate for
  // "is this a valid English build?".
  const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
  if (!pkg.publisher || !ID_RE.test(pkg.publisher)) {
    errors.push('package.json publisher must be lowercase letters, digits and hyphens: ' + JSON.stringify(pkg.publisher));
  } else if (pkg.publisher === 'vithrive' && !/Vithrive/.test(String(pkg.repository && pkg.repository.url))) {
    // Upstream's publisher id belongs to the Chinese project. Carrying it here would
    // claim their identity, so treat it as an error rather than a style nit.
    errors.push('package.json declares upstream\'s publisher "vithrive" but the repository is not upstream\'s');
  }
  if (!pkg.name || !ID_RE.test(pkg.name)) {
    errors.push('package.json name must be lowercase letters, digits and hyphens: ' + JSON.stringify(pkg.name));
  }
  if (!pkg.displayName || CJK.test(pkg.displayName)) {
    errors.push('package.json displayName must be present and free of Chinese: ' + JSON.stringify(pkg.displayName));
  }
  if (!pkg.engines || !pkg.engines.vscode) {
    errors.push('package.json must declare engines.vscode');
  }
  if (!pkg.license) {
    warnings.push('package.json declares no license');
  }
  if (!String(pkg.description || '').startsWith('%') && CJK.test(String(pkg.description || ''))) {
    errors.push('package.json description still contains Chinese');
  }
  if (!fs.existsSync(PATH.join(ROOT, pkg.icon || 'media/icon.png'))) {
    errors.push('package.json icon does not exist: ' + JSON.stringify(pkg.icon));
  }
  // The README is the face of the fork on GitHub and inside the packaged extension.
  const readmeChars = (fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').match(CJK) || []).length;
  if (readmeChars > 0) {
    errors.push('README.md contains ' + readmeChars + ' Chinese characters');
  }

  // ---- report -------------------------------------------------------------
  if (process.argv.includes('--list')) {
    console.log('--- translated keys ---');
    for (const key of Object.keys(bundle).sort()) console.log('  ' + key);
    console.log('');
  }

  console.log('l10n-check: ' + calls.length + ' translated calls, ' + Object.keys(bundle).length + ' dictionary entries, ' + manifestHits.length + ' untranslated manifest strings');
  if (notes.length) {
    console.log('\n' + notes.length + ' allowed raw literal(s):');
    for (const n of notes) console.log('  · ' + n);
  }
  if (warnings.length) {
    console.log('\n' + warnings.length + ' warning(s):');
    for (const w of warnings) console.log('  ! ' + w);
  }
  if (errors.length) {
    console.log('\n' + errors.length + ' error(s):');
    for (const e of errors) console.log('  ✗ ' + e);
    console.log('\nFAIL: some user-facing strings have no English translation.');
    process.exit(1);
  }
  console.log('\nOK: every user-facing string resolves to English.');
}

main();
