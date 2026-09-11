#!/usr/bin/env node
'use strict';

/**
 * Run every test file in test/ and report a summary.
 *
 * `test/e2e-real-dsh.test.js` needs a real `dsh` installation and a writable
 * ~/.dsh profile, so it is skipped unless it can run. Every other file is
 * self-contained and must pass.
 *
 * Usage: node test/run-all.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

const results = [];
for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
  const out = (res.stdout || '') + (res.stderr || '');
  const skipped = /skip/i.test(out) && res.status === 0;
  results.push({ file, code: res.status, out, skipped });
  const label = res.status === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL';
  console.log(label + '  ' + file);
  if (res.status !== 0) {
    const tail = out.trim().split('\n').slice(-8).join('\n');
    console.log('      ' + tail.split('\n').join('\n      '));
  }
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' test files passed.');
if (failed.length) process.exit(1);
