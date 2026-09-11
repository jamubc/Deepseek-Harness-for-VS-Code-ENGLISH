'use strict';
/**
 * Tests for the generated files of the built-in clipboard compatibility plugin
 * (dsh-webview-clipboard, PR #11).
 * Run: node test/clipboard-plugin.test.js
 * Why it matters: client.js is generated from template literals, and a single
 * regex-escaping mistake makes the DSH page fail to load on every platform — so
 * the generated output gets a real syntax check here (node --check).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
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
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { clipboardPluginFiles, CLIPBOARD_PLUGIN_NAME } = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const files = clipboardPluginFiles();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clip-'));
for (const rel of Object.keys(files)) {
  const dest = path.join(base, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, files[rel], 'utf8');
}

console.log('[1] all files present');
ok(files['package.json'] && files['lib/index.js'] && files['lib/client.js'] && files['cordis.patch.yml'], 'all four files present');
ok(files['lib/client.js'].includes(CLIPBOARD_PLUGIN_NAME), 'client.js carries the plugin id');

console.log('[2] package.json parses and declares things correctly');
const pkg = JSON.parse(files['package.json']);
ok(pkg.name === CLIPBOARD_PLUGIN_NAME, 'name is correct');
ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'client.platform=web');
ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch points at cordis.patch.yml (the string form real plugins use by convention)');

console.log('[3] real syntax validation of the generated JS (node --check)');
for (const js of ['lib/index.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(base, js)], { encoding: 'utf8' });
  ok(r.status === 0, js + ' passes the syntax check' + (r.status !== 0 ? ': ' + (r.stderr || '').slice(0, 300) : ''));
}

console.log('[4] regex escaping is not collapsed by the template literal (the trap the author flagged)');
ok(files['lib/client.js'].includes('/Electron\\//'), 'the Electron regex keeps its backslash escape (/Electron\\/ matches "Electron/")');

console.log('[5] activation gates and safety valves are present');
ok(files['lib/client.js'].includes('inIframe()') && files['lib/client.js'].includes('isMac()') && files['lib/client.js'].includes('inElectron()'), 'three-way activation gate (iframe + macOS + Electron)');
ok(files['lib/client.js'].includes('defaultPrevented'), 'respects keys DSH has already handled');
ok(files['lib/client.js'].includes('229'), 'does not interfere during IME composition');

console.log('[6] narrowed scope (PR #14): only the three clipboard keys, editor keys are no longer simulated');
ok(files['lib/client.js'].includes("cmd = 'paste'") && files['lib/client.js'].includes("cmd = 'copy'") && files['lib/client.js'].includes("cmd = 'cut'"), '⌘C/⌘V/⌘X handled through execCommand');
ok(!files['lib/client.js'].includes('selectAll'), '⌘A is no longer intercepted (native behavior works)');
ok(!files['lib/client.js'].includes("'redo'"), 'undo/redo are no longer intercepted');
ok(!files['lib/client.js'].includes('setSelectionRange'), 'the caret is no longer simulated manually (el.value crashes under contentEditable)');
ok(!files['lib/client.js'].includes('el.value'), 'el.value is no longer read (contentEditable has no such property)');

console.log('[6b] cordis.patch.yml structure');
ok(/-\s*insert:/.test(files['cordis.patch.yml']), 'the insert line is present');
ok(files['cordis.patch.yml'].includes("name: '" + CLIPBOARD_PLUGIN_NAME + "'"), 'name matches the package name');

fs.rmSync(base, { recursive: true, force: true });
console.log('\nAll passed: ' + passed + ' assertions ✓');
process.exit(0);
