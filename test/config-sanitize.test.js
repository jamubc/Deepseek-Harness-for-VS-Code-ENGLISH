'use strict';
/** Configuration input sanitization tests (regression cases from the PR #12 security audit). Run: node test/config-sanitize.test.js */
const assert = require('assert');
const path = require('path');
const Module = require('module');

const settings = {};
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), workspaceFolders: [] },
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
const { getHost, getPort, getDshCommand, sanitizeCommand } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}
function caseOf(setter, actual, want, name) {
  setter();
  const got = typeof actual === 'function' ? actual() : actual;
  assert.deepStrictEqual(got, want, name + ' (actual ' + JSON.stringify(got) + ')');
  ok(true, name);
}

console.log('[1] dshPanel.port (declared as number, but the raw value passes straight through)');
caseOf(() => { settings['dshPanel.port'] = '3080 && calc'; }, () => getPort(), 3080, 'string injection → falls back to 3080');
caseOf(() => { settings['dshPanel.port'] = '4000'; }, () => getPort(), 4000, 'a purely numeric string still works');
caseOf(() => { settings['dshPanel.port'] = 99999; }, () => getPort(), 3080, 'out-of-range port → falls back to 3080');
caseOf(() => { settings['dshPanel.port'] = -1; }, () => getPort(), 3080, 'negative port → falls back to 3080');
caseOf(() => { settings['dshPanel.port'] = 3000.9; }, () => getPort(), 3000, 'decimal → truncated to an integer');

console.log('[2] dshPanel.host (a string setting)');
caseOf(() => { settings['dshPanel.host'] = '127.0.0.1 & calc'; }, () => getHost(), '127.0.0.1', 'shell metacharacters → falls back to 127.0.0.1');
caseOf(() => { settings['dshPanel.host'] = 'my-dsh.local'; }, () => getHost(), 'my-dsh.local', 'a valid hostname is kept');
caseOf(() => { settings['dshPanel.host'] = '::1'; }, () => getHost(), '::1', 'an IPv6 literal is kept');

console.log('[3] dshPanel.dshCommand (a string command path)');
caseOf(() => { settings['dshPanel.dshCommand'] = 'dsh & calc'; }, () => getDshCommand(), 'dsh', 'metacharacter injection → falls back to dsh');
caseOf(() => { settings['dshPanel.dshCommand'] = 'C:\my tools\dsh.cmd'; }, () => getDshCommand(), 'C:\my tools\dsh.cmd', 'a valid path with spaces is kept (quoted automatically before launch)');
ok(sanitizeCommand('dsh\r malicious') === null, 'carriage return / line feed rejected');
ok(sanitizeCommand('dsh`id`') === null, 'backtick rejected');
ok(sanitizeCommand('dsh|calc') === null, 'pipe rejected');
ok(sanitizeCommand('dsh>nul') === null, 'redirection rejected');

console.log('\nAll passed: ' + passed + ' assertions ✓');
process.exit(0);
