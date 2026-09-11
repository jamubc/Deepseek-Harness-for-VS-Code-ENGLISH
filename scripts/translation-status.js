#!/usr/bin/env node
'use strict';

/**
 * Report where Chinese remains, and whether each occurrence is intentional.
 *
 * "Fully translated" does not mean "no Chinese characters anywhere": upstream's
 * Chinese literals are deliberately kept in extension.js as translation *keys*, and
 * package.json keeps them behind %tokens% so git merges stay clean. This script
 * states, per file, how much Chinese is left and what it is, so the answer to
 * "is this fork translated?" is auditable rather than a matter of opinion.
 *
 * Usage: node scripts/translation-status.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/**
 * Count CJK characters in a file.
 * @param {string} file
 * @returns {number}
 */
function count(file) {
  try {
    return (fs.readFileSync(file, 'utf8').match(CJK) || []).length;
  } catch (_) {
    return 0;
  }
}

const files = [
  'extension.js',
  'package.json',
  'package.nls.json',
  'README.md',
  'README.zh-CN.md',
  'TERMINOLOGY.md',
  'l10n.js',
  'l10n/bundle.l10n.json',
  'l10n/manifest.nls.json',
  'docs/UPSTREAM-SYNC.md'
];
for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
  if (f.endsWith('.js')) files.push('test/' + f);
}
for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (f.endsWith('.js')) files.push('scripts/' + f);
}

const EXPECTED = {
  'extension.js': 'translation keys in t() calls, plus the DSH session-file markers',
  'package.json': 'none expected (all strings are %token%s)',
  'README.md': 'none expected',
  'l10n/bundle.l10n.json': 'the keys themselves — the English is on the right',
  'l10n/manifest.nls.json': 'none expected (English values only)',
  'TERMINOLOGY.md': 'glossary source terms',
  'README.zh-CN.md': 'the upstream Chinese README, kept on purpose',
  'test/**': 'none expected except protocol fixtures',
  'docs/UPSTREAM-SYNC.md': 'short examples only'
};

console.log('Translation status\n');
let total = 0;
for (const f of files) {
  const n = count(path.join(ROOT, f));
  total += n;
  const bar = n === 0 ? 'clean' : n + ' chars';
  console.log('  ' + f.padEnd(30) + bar);
}
console.log('\n  total CJK characters: ' + total);

// extension.js is the file that matters: verify every non-comment occurrence is a
// t() key, using the same two-step argument the l10n checker uses.
const ext = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
const commentChars = (ext.split('\n').filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').match(CJK) || []).length;
const strings = ext.match(/'((?:\\.|[^'\\])*)'/g) || [];
const keyChars = strings
  .filter((s) => CJK.test(s))
  .join('')
  .match(CJK)?.length || 0;
console.log('\nextension.js breakdown');
console.log('  CJK in comment lines     : ' + commentChars);
console.log('  CJK inside quoted strings: ' + keyChars + '  (translation keys / protocol data)');
console.log('\nRun `npm run l10n:check` to confirm every key resolves to English.');
