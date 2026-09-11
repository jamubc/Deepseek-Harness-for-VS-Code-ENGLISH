'use strict';
/**
 * Command execution security tests (adopts the injection cases designed in PR #12
 * plus regression coverage for the platform-specific execution paths).
 * Run: node test/command-execution.test.js
 *
 * Covers:
 *  - runCommandOk: a real command succeeds / an unknown command fails / metacharacter injection is rejected
 *  - runCommandOutput: POSIX goes through shell-free execFile (the second layer of
 *    defense from PR #12), Windows goes through the sanitized shell-quoting path;
 *    both paths reject metacharacter injection
 *  - output is not corrupted by concatenation (array arguments go straight to the process)
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: [] },
  env: { remoteName: undefined },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const { runCommandOk, runCommandOutput } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

async function main() {
  console.log('[1] runCommandOk: real command / unknown command / injection rejected');
  {
    const okRun = await runCommandOk(process.execPath, ['-v'], 15000);
    ok(okRun === true, 'node -v exit code 0 → true');
    const badRun = await runCommandOk('definitely-not-a-real-command-xyz', ['--version'], 15000);
    ok(badRun === false, 'unknown command → false');
  }

  console.log('[2] runCommandOk: every metacharacter injection is rejected (PR #12 cases)');
  {
    const injections = [
      'dsh; touch /tmp/pwned',
      'dsh & calc',
      'dsh && ls',
      'dsh || ls',
      'dsh | cat /etc/passwd',
      'dsh$(touch /tmp/pwned)',
      'dsh`touch /tmp/pwned`',
      'dsh\ntouch /tmp/pwned',
      'dsh>out.txt',
      'dsh<in.txt'
    ];
    let rejected = 0;
    for (const bad of injections) {
      const r = await runCommandOk(bad, ['--version'], 15000);
      if (r === false) rejected += 1;
    }
    ok(rejected === injections.length, 'all 10 injection forms rejected (' + rejected + '/' + injections.length + ')');
  }

  console.log('[3] runCommandOutput: array arguments go straight to the process, output is correct');
  {
    const out = await runCommandOutput(process.execPath, ['-e', 'console.log(6*7)'], 15000);
    ok(String(out).trim() === '42', 'cross-platform output 42 (actual ' + JSON.stringify(String(out).trim()) + ')');
  }

  console.log('[4] runCommandOutput: metacharacter injection rejected');
  {
    let rejected = 0;
    const bads = ['dsh; pwned', 'dsh & pwned', 'dsh|pwned', 'dsh`pwned`'];
    for (const bad of bads) {
      let failed = false;
      try { await runCommandOutput(bad, ['--version']); } catch (e) { failed = true; }
      if (failed) rejected += 1;
    }
    ok(rejected === bads.length, 'every metacharacter command rejected (' + rejected + '/' + bads.length + ')');
  }
}

main().then(() => {
  console.log('\nAll passed: ' + passed + ' assertions ✓');
  process.exit(0);
}, (e) => {
  console.error(e);
  process.exit(1);
});
