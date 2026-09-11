'use strict';
/**
 * macOS interaction simulation tests: drive the onKeyDown handler of
 * dsh-webview-clipboard 0.2.1 with a macOS UA + Electron + iframe environment and
 * verify the behavior key by key (after the PR #14 scope reduction).
 * Run: node test/macos-keysim.test.js
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
const { clipboardPluginFiles } = require(path.join(__dirname, '..', 'extension.js')).__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

/** Build a macOS + Electron + iframe page sandbox and load the generated client.js into it. */
function makeSandbox({ mac = true, electron = true, iframe = true } = {}) {
  const ua = 'Mozilla/5.0 (' + (mac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0') + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' + (electron ? ' Electron/28.0.0' : '');
  const listeners = {};
  const execCalls = [];
  let execResult = true;
  const win = {
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    parent: iframe ? {} : null // in a real browser a top-level window has parent === window (self-reference)
  };
  if (!iframe) win.parent = win;
  win.__ModuleLoader__ = {
    load: ({ factory }) => {
      const mod = factory(function () { throw new Error('client.js must not require host modules'); });
      mod.apply();
    }
  };
  const nav = { userAgent: ua, platform: mac ? 'MacIntel' : 'Win32', userAgentData: undefined };
  const doc = {
    execCommand: (cmd) => { execCalls.push(cmd); return execResult; },
    addEventListener: () => {}
  };
  const code = clipboardPluginFiles()['lib/client.js'];
  new Function('window', 'navigator', 'document', code)(win, nav, doc);
  const keydown = listeners['keydown'][0];
  return {
    keydown, execCalls,
    setExecResult: (v) => { execResult = v; },
    state: () => win.__dshWebviewClipboard
  };
}

/** Synthesize a KeyboardEvent. */
function makeEvent(target, opts) {
  const o = opts || {};
  const ev = { target, key: o.key || '', metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey, altKey: !!o.altKey, shiftKey: !!o.shiftKey, isComposing: !!o.isComposing, keyCode: o.keyCode || 0, defaultPrevented: !!o.defaultPrevented, preventDefaultCount: 0 };
  ev.preventDefault = () => { ev.preventDefaultCount += 1; ev.defaultPrevented = true; };
  return ev;
}
const textarea = () => ({ nodeType: 1, tagName: 'TEXTAREA', isContentEditable: false, value: 'hello 世界', selectionStart: 5, selectionEnd: 5 });
const richtext = () => ({ nodeType: 1, tagName: 'DIV', isContentEditable: true }); // deliberately no value (contentEditable has no such property)

console.log('[1] macOS · editable element (textarea)');
{
  const sb = makeSandbox();
  ok(sb.state().enabled === true && sb.state().mac === true, 'activation gate hit (macOS + Electron + iframe)');
  ok(sb.state().version === '0.2.1', 'version 0.2.1');
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C → preventDefault + execCommand(copy)');
  ev = makeEvent(textarea(), { key: 'v', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('paste'), '⌘V → preventDefault + execCommand(paste)');
  ev = makeEvent(textarea(), { key: 'x', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('cut'), '⌘X → preventDefault + execCommand(cut)');
}

console.log('[2] macOS · contentEditable rich text (composer body, regression for the v0.2.0 crash)');
{
  const sb = makeSandbox();
  let ev = makeEvent(richtext(), { key: 'ArrowLeft', metaKey: true });
  let threw = false;
  try { sb.keydown(ev); } catch (e) { threw = true; }
  ok(!threw, '⌘← no longer throws a TypeError (the v0.2.0 el.value read that crashed is gone)');
  ok(ev.preventDefaultCount === 0, '⌘← is handed back to native behavior');
  ev = makeEvent(richtext(), { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C is still intercepted by the fix on rich text');
}

console.log('[3] macOS · non-editable area (copying selected chat content)');
{
  const sb = makeSandbox();
  const staticText = { nodeType: 1, tagName: 'P', isContentEditable: false };
  let ev = makeEvent(staticText, { key: 'c', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1 && sb.execCalls.includes('copy'), '⌘C still copies the page selection');
  ev = makeEvent(staticText, { key: 'x', metaKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 1, '⌘X runs explicitly (a no-op on read-only content, same as native)');
}

console.log('[4] macOS · keys no longer intercepted (handed back to native/editor, PR #14 scope reduction)');
{
  const sb = makeSandbox();
  const cases = [
    [{ key: 'a', metaKey: true }, '⌘A'],
    [{ key: 'z', metaKey: true }, '⌘Z'],
    [{ key: 'z', metaKey: true, shiftKey: true }, '⌘⇧Z'],
    [{ key: 'ArrowLeft', metaKey: true }, '⌘←'],
    [{ key: 'ArrowRight', altKey: true }, '⌥→'],
    [{ key: 'Backspace', altKey: true }, '⌥⌫'],
    [{ key: 'x', metaKey: true, shiftKey: true }, '⌘⇧X (mixed modifiers)']
  ];
  for (const c of cases) {
    const ev = makeEvent(textarea(), c[0]);
    let threw = false;
    try { sb.keydown(ev); } catch (e) { threw = true; }
    ok(!threw && ev.preventDefaultCount === 0, c[1] + ' not intercepted, no error (handed back to native)');
  }
}

console.log('[5] macOS · safety valves');
{
  const sb = makeSandbox();
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true, defaultPrevented: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, 'keys the page already handled are not overridden');
  ev = makeEvent(textarea(), { key: 'c', metaKey: true, isComposing: true, keyCode: 229 });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, 'does not interfere during IME composition');
  ev = makeEvent(textarea(), { key: 'c', metaKey: true, altKey: true });
  sb.keydown(ev);
  ok(ev.preventDefaultCount === 0, '⌘⌥ mixed modifiers are left alone');
}

console.log('[6] Windows / non-embedded environments (regression: behavior is completely unchanged)');
{
  const sbWin = makeSandbox({ mac: false });
  ok(sbWin.state().enabled === false, 'Windows: the plugin does not activate');
  let ev = makeEvent(textarea(), { key: 'c', metaKey: true });
  sbWin.keydown(ev);
  ok(ev.preventDefaultCount === 0 && sbWin.execCalls.length === 0, 'Windows: ⌘C native behavior is unaffected');
  const sbBrowser = makeSandbox({ iframe: false });
  ok(sbBrowser.state().enabled === false, 'DSH opened in a normal browser: not activated');
  const ev2 = makeEvent(textarea(), { key: 'v', metaKey: true });
  sbBrowser.keydown(ev2);
  ok(ev2.preventDefaultCount === 0 && sbBrowser.execCalls.length === 0, 'browser-embedded case: the native clipboard is unaffected');
}

console.log('\nAll passed: ' + passed + ' assertions ✓');
process.exit(0);
