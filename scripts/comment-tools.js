#!/usr/bin/env node
'use strict';

/**
 * Comment translation helpers.
 *
 * Translating a 3,600-line file by hand risks changing code. Instead this tool
 * splits the job mechanically:
 *
 *   --dump <from> <to>   print each Chinese comment line in a line range as JSON
 *   --apply <file.json>  replace comment text by line number, refusing any edit that
 *                        would touch a line of code
 *
 * `--apply` verifies, for every entry, that the target line still is a comment and
 * that its comment *marker* (its indentation plus `//`, `*`, or `/*`) is unchanged.
 * Anything else is reported and skipped, so a stale line number can never corrupt
 * the file. After applying, run `scripts/verify-comment-only.js` for the full proof.
 *
 * Usage:
 *   node scripts/comment-tools.js --dump 0 800 > chunk.json
 *   node scripts/comment-tools.js --apply chunk.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXTENSION = path.join(ROOT, 'extension.js');
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Protocol markers a translated comment may still quote.
 *
 * These strings are data: extension.js writes them into Copilot transcripts and
 * matches them back out of DSH session files, so a comment explaining that logic is
 * clearer when it shows the literal. They are the same three entries the l10n check
 * allows, plus the submission marker.
 */
const QUOTABLE_PROTOCOL = /用户：|助手：|【[^】]*】|⏳ 已提交给 DeepSeek Harness/g;

/**
 * Split a source line into its comment marker and its comment text.
 *
 * Handles both a whole-line comment (`// …`, `* …`, `/* … `) and a *trailing*
 * comment after code (`return x; // …`). The marker is everything up to and
 * including the comment delimiter, so callers can rebuild the line exactly by
 * concatenating `marker + text`.
 *
 * @param {string} line
 * @returns {{marker: string, text: string}|null}
 */
function splitComment(line) {
  const whole = /^(\s*\/\/\s?|\s*\*\s?|\s*\/\*\s?)(.*)$/.exec(line);
  if (whole) return { marker: whole[1], text: whole[2] };
  // Trailing comment: find a // that is not inside a quoted string.
  let quote = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') {
      const head = line.slice(0, i);
      const rest = line.slice(i);
      const m = /^(\/\/\s?)(.*)$/.exec(rest);
      if (!m) return null;
      // Keep the code plus the alignment whitespace as the marker.
      const pad = /\s*$/.exec(head)[0];
      return { marker: head.slice(0, head.length - pad.length) + pad + m[1], text: m[2] };
    }
  }
  return null;
}

const mode = process.argv[2];

if (mode === '--dump') {
  const from = Number(process.argv[3] || 0);
  const to = Number(process.argv[4] || Number.MAX_SAFE_INTEGER);
  const lines = fs.readFileSync(EXTENSION, 'utf8').split('\n');
  const out = [];
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    const line = lines[i];
    if (!CJK.test(line)) continue;
    const parts = splitComment(line);
    if (!parts) continue; // Chinese in code or a string: not a comment
    if (!CJK.test(parts.text)) continue;
    out.push({ line: i + 1, marker: parts.marker, zh: parts.text });
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else if (mode === '--apply') {
  const file = process.argv[3];
  if (!file) {
    console.error('usage: node scripts/comment-tools.js --apply <translations.json>');
    process.exit(2);
  }
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = fs.readFileSync(EXTENSION, 'utf8');
  const lines = raw.split('\n');
  const skipped = [];
  let applied = 0;

  for (const entry of entries) {
    const idx = entry.line - 1;
    const current = lines[idx];
    if (typeof current !== 'string') { skipped.push([entry.line, 'line missing']); continue; }
    const parts = splitComment(current);
    if (!parts) { skipped.push([entry.line, 'not a comment line']); continue; }
    if (CJK.test(parts.text) === false && parts.text.trim() !== '') {
      skipped.push([entry.line, 'already translated']);
      continue;
    }
    if (typeof entry.en !== 'string' || !entry.en.trim()) {
      skipped.push([entry.line, 'empty translation']);
      continue;
    }
    // Chinese is only permitted where it is quoting a protocol marker.
    const residue = entry.en.replace(QUOTABLE_PROTOCOL, '');
    if (CJK.test(residue)) { skipped.push([entry.line, 'translation still holds Chinese']); continue; }
    lines[idx] = entry.marker + entry.en;
    applied += 1;
  }

  fs.writeFileSync(EXTENSION, lines.join('\n'));
  console.log('applied ' + applied + '/' + entries.length + ' comment translations');
  if (skipped.length) {
    console.log('skipped ' + skipped.length + ':');
    for (const [line, why] of skipped) console.log('  line ' + line + ': ' + why);
    process.exit(1);
  }
} else {
  console.error('usage: node scripts/comment-tools.js --dump <from> <to> | --apply <translations.json>');
  process.exit(2);
}
