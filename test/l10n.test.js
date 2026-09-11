'use strict';
/**
 * Language-pack tests: placeholder formatting, dictionary coverage, protocol
 * strings, and the manifest patch applied at activation.
 *
 * These run under plain Node with no VS Code, which is exactly the situation the
 * `l10n.js` fallback dictionary exists to handle. Run: node test/l10n.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const l10n = require(path.join(__dirname, '..', 'l10n.js'));

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  x ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ok ' + name);
}

console.log('l10n: runtime translation');

// --- basic lookup, no VS Code present ---------------------------------------
const connected = l10n.t('无法连接 DeepSeek Harness');
ok(connected === 'Cannot connect to DeepSeek Harness', 'translates a plain message without vscode loaded');
ok(!/[\u4e00-\u9fff]/.test(connected), 'result contains no Chinese');

// --- placeholder substitution ------------------------------------------------
ok(l10n.t('工作区：{0}', ['/tmp/ws']) === 'Workspace: /tmp/ws', 'substitutes positional {0}');
ok(l10n.t('无法解析显示地址：{0}', ['http://x']) === 'Cannot parse the display URL: http://x', 'substitutes a URL argument');
ok(l10n.t('已认证（受管代理 {0}）', ['127.0.0.1:9']) === 'Authenticated (managed proxy 127.0.0.1:9)', 'substitutes inside parentheses');
ok(l10n.t('正在处理（{0}/{1}）…', [2, 10]) === 'Working (2/10)…', 'substitutes multiple positional placeholders');
ok(l10n.t('DSH 服务可达: {0}', ['yes (x)']) === 'DSH service reachable: yes (x)', 'substitutes a nested translation result');

// --- every placeholder in a key survives into the value ----------------------
const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.json'), 'utf8'));
let checked = 0;
for (const [key, value] of Object.entries(bundle)) {
  const inKey = new Set(key.match(/\{(\d+|[A-Za-z_]\w*)\}/g) || []);
  for (const token of inKey) {
    assert.ok(value.includes(token), 'placeholder ' + token + ' missing from translation of ' + key);
    checked += 1;
  }
}
ok(checked > 0, 'checked ' + checked + ' placeholder occurrences across the dictionary');

// --- protocol strings stay in lockstep --------------------------------------
ok(l10n.t('用户：') === 'User: ', 'user prefix becomes English');
ok(l10n.t('助手：') === 'Assistant: ', 'assistant prefix becomes English');
ok(l10n.t('【文件引用】') === '[File references]', 'file-reference block becomes English');
ok(l10n.t('【Copilot 其他模型回答】') === '[Answer from another Copilot model] ', 'foreign-answer label becomes English');
ok(l10n.t('⏳ 已提交给 DeepSeek Harness').startsWith('⏳ Submitted to DeepSeek Harness'), 'submission marker shared with DSH_ANSWER_MARKER becomes English');

// --- the marker used for transcript parsing must be self-consistent ---------
// extension.js derives DSH_ANSWER_MARKER from t(), so the label it writes and the
// label it later looks for cannot drift apart.
const marker = l10n.t('⏳ 已提交给 DeepSeek Harness');
ok(marker === l10n.t('⏳ 已提交给 DeepSeek Harness'), 'marker lookup is stable across calls');

// --- unknown strings degrade loudly, never throw ----------------------------
const unknown = l10n.t('这是一条尚未翻译的新字符串');
ok(typeof unknown === 'string' && unknown.length > 0, 'unknown string returns a string rather than throwing');
ok(unknown.includes('untranslated'), 'unknown string is flagged as untranslated');

// --- comments participate in the key, like @vscode/l10n-dev ----------------
ok(l10n.t({ message: '未知', comment: 'ctx' }).includes('untranslated'), 'comment form does not crash on a miss');

console.log('l10n: manifest patch');

// --- manifest patch ---------------------------------------------------------
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Simulate what VS Code hands the extension: the manifest with %key% already
// resolved by package.nls.json for the Extensions view and Settings UI.
const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls.json'), 'utf8'));
// VS Code's localizeManifest walks the manifest *object* and swaps %key% strings,
// so model it that way: a text-level replace would break on the embedded quotes in
// values such as the description.
const localizeManifest = (node) => {
  if (typeof node === 'string') {
    if (node.length > 1 && node[0] === '%' && node.endsWith('%')) {
      const key = node.slice(1, -1);
      return key in nls ? nls[key] : node;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map(localizeManifest);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) out[k] = localizeManifest(node[k]);
    return out;
  }
  return node;
};
const resolvedManifest = localizeManifest(JSON.parse(JSON.stringify(pkg)));

// The extension host copy, however, is the raw manifest; the patch fixes that one.
const rawCopy = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
l10n.applyManifestTranslations(rawCopy);

const rawWatch = JSON.stringify(rawCopy.contributes.configuration.properties);
ok(!/[\u4e00-\u9fff]/.test(rawWatch), 'every configuration description is English after the patch');
ok(
  rawCopy.contributes.configuration.properties['dshPanel.autoStart'].description ===
  nls['configuration.properties.dshPanel.autoStart.description'],
  'patched description matches the nls table'
);

const patchedCmd = rawCopy.contributes.commands.find((c) => c.command === 'dshPanel.refresh');
ok(patchedCmd.title === 'DeepSeek Harness: Refresh', 'command title is English after the patch');

ok(
  rawCopy.description === resolvedManifest.description,
  'patched root description matches what package.nls.json produces'
);

// --- untouched values stay untouched ---------------------------------------
ok(
  rawCopy.contributes.configuration.properties['dshPanel.url'].type === 'string',
  'non-string manifest fields are not overwritten'
);
ok(
  JSON.stringify(rawCopy.contributes.configuration.properties['dshPanel.dshReasoningEffort'].enum) ===
  JSON.stringify(pkg.contributes.configuration.properties['dshPanel.dshReasoningEffort'].enum),
  'enum values are not overwritten'
);

// --- the patch must be idempotent ------------------------------------------
const once = JSON.stringify(rawCopy);
l10n.applyManifestTranslations(rawCopy);
ok(JSON.stringify(rawCopy) === once, 'applying the patch twice changes nothing');

console.log('l10n: helpers');

// --- format2 mirrors VS Code's substitution rules --------------------------
ok(l10n.format2('a {0} b {1}', [1, 2]) === 'a 1 b 2', 'format2 substitutes multiple positional placeholders');
ok(l10n.format2('hi {name}', { name: 'Ada' }) === 'hi Ada', 'format2 substitutes named placeholders');
ok(l10n.format2('no args', undefined) === 'no args', 'format2 tolerates undefined args');
ok(l10n.format2('{0} and {0}', ['x']) === 'x and x', 'format2 replaces every occurrence');

// --- bundleSnapshot is a copy, so callers cannot mutate the dictionary -----
const snap = l10n.bundleSnapshot();
const snapKey = Object.keys(snap)[0];
const original = snap[snapKey];
snap[snapKey] = 'mutated';
ok(l10n.bundleSnapshot()[snapKey] === original, 'bundleSnapshot returns a copy, not the live dictionary');

// --- the table exposes exactly the manifest strings we expect --------------
const table = l10n.manifestTranslations();
ok(Object.keys(table).length > 0, 'manifest translation table is loaded');
ok(typeof table['description'] === 'string', 'manifest table covers the root description');
ok(
  Object.values(table).every((v) => typeof v === 'string'),
  'every manifest table value is a string'
);

console.log('\nAll passed: ' + passed + ' assertions');
