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

  // ---- 6. package.nls.json must exist and cover every manifest entry ------
  if (fs.existsSync(PACKAGE_NLS)) {
    const nls = readJson(PACKAGE_NLS, 'package.nls.json');
    const nlsKeys = new Set(Object.keys(nls));
    for (const dotted of Object.keys(manifestNls)) {
      if (typeof manifestNls[dotted] !== 'string') continue;
      if (!nlsKeys.has(dotted)) {
        warnings.push('package.nls.json has no key for ' + dotted + ' (run: node scripts/l10n-sync-manifest.js)');
      }
    }
  } else {
    warnings.push('package.nls.json does not exist (run: node scripts/l10n-sync-manifest.js)');
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
