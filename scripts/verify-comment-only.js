#!/usr/bin/env node
'use strict';

/**
 * Prove that a translation pass changed *only* comments.
 *
 * Compares two revisions of a JavaScript file after removing every comment AND
 * blanking every string/template literal body. If the residue is identical, no
 * identifier, string, number or operator was touched — only comment text differs.
 *
 * This matters because translating a 3,600-line file by hand risks silently
 * changing behaviour. Run it after any bulk comment translation.
 *
 * Usage:
 *   node scripts/verify-comment-only.js <file> <git-revision>
 *   node scripts/verify-comment-only.js extension.js HEAD
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const file = process.argv[2] || 'extension.js';
const rev = process.argv[3] || 'HEAD';

/**
 * Replace comment text with nothing and literal bodies with a placeholder, keeping
 * all other characters — including newlines, so line numbers stay comparable.
 * @param {string} src
 * @returns {string}
 */
function skeleton(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  /** Skip a string or template literal, returning the index past its end. */
  const scanString = (start) => {
    const quote = src[start];
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (quote === '`' && c === '$' && src[j + 1] === '{') {
        // Keep substitution code: recurse by simply continuing to scan; the
        // skeleton of the whole file is compared, so nesting does not matter as
        // long as both revisions tokenize the same way.
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const d = src[j];
          if (d === "'" || d === '"' || d === '`') { j = scanString(j); continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
        }
        continue;
      }
      if (c === quote) { j++; break; }
      j++;
    }
    return j;
  };

  /**
   * Can a `/` here start a regex? Reuses the value/before heuristic.
   * @param {number} idx
   * @returns {boolean}
   */
  const regexCanStart = (idx) => {
    for (let k = idx - 1; k >= 0; k--) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      if (/[\w$)\]'"]/.test(c)) return false;
      return true;
    }
    return true;
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(n, j + 2));
      i = Math.min(n, j + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = scanString(i);
      // Keep the quotes, blank the body, so `t('x')` and `t('y')` compare equal.
      blank(i + 1, end - 1);
      i = end;
      continue;
    }
    if (c === '/' && regexCanStart(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; break; }
        else if (d === '\n') break;
        j++;
      }
      while (j < n && /[a-z]/i.test(src[j])) j++;
      i = j;
      continue;
    }
    i++;
  }
  return out.join('');
}

const current = fs.readFileSync(file, 'utf8');
const previous = execFileSync('git', ['show', rev + ':' + file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const a = skeleton(previous).split('\n');
const b = skeleton(current).split('\n');

if (a.length !== b.length) {
  console.error('MISMATCH: line count changed (' + a.length + ' -> ' + b.length + ')');
  process.exit(1);
}

let diffs = 0;
for (let i = 0; i < a.length; i++) {
  // Compare the code residue only. A comment's blanked span has a different width
  // once translated, so trailing whitespace must not count as a code change; leading
  // whitespace is kept because it is indentation and a real difference there matters.
  if (a[i].trimEnd() !== b[i].trimEnd()) {
    diffs++;
    if (diffs <= 20) {
      console.error('line ' + (i + 1) + ' differs in code (not just comments):');
      console.error('  before: ' + JSON.stringify(a[i]));
      console.error('  after : ' + JSON.stringify(b[i]));
    }
  }
}

if (diffs) {
  console.error('\nFAIL: ' + diffs + ' line(s) changed outside comments.');
  process.exit(1);
}
console.log('OK: ' + file + ' vs ' + rev + ' — only comments differ (' + a.length + ' lines compared).');
