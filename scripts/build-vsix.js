#!/usr/bin/env node
'use strict';

/**
 * Build a .vsix without any dependencies.
 *
 * `vsce` is the canonical packager, but it needs npm and a writable cache, which are
 * not always available (a locked-down or read-only machine, for instance). A .vsix is
 * only a ZIP with a fixed layout, so this script produces one directly:
 *
 *   extension.vsixmanifest   the package manifest, with the extension's own
 *                            package.json embedded as CDATA
 *   [Content_Types].xml      the OPC content-type map
 *   extension/**             the extension files, respecting .vscodeignore
 *
 * Use it when vsce cannot run; the result installs with
 * `code --install-extension <file>.vsix` exactly like a vsce build.
 *
 * Usage:
 *   node scripts/build-vsix.js [--out dist] [--target <platform>]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * Translate `.vscodeignore` globs into a matcher.
 *
 * Only the subset this repo uses is supported — exact paths, `dir/**` and `*.ext` —
 * and anything unrecognised is treated as "not ignored" so a mistake here can only
 * ship an extra file, never drop a needed one.
 *
 * @param {string[]} patterns
 * @returns {(relPath: string) => boolean}
 */
function makeIgnoreMatcher(patterns) {
  const tests = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith('#')) continue;
    if (p.endsWith('/**')) {
      const dir = p.slice(0, -3).replace(/\/$/, '');
      tests.push((rel) => rel === dir || rel.startsWith(dir + '/'));
    } else if (p.startsWith('*.')) {
      const ext = p.slice(1);
      tests.push((rel) => rel.endsWith(ext));
    } else if (p.includes('*')) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
      tests.push((rel) => re.test(rel));
    } else {
      tests.push((rel) => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'));
    }
  }
  return (rel) => tests.some((t) => t(rel));
}

/**
 * Walk the extension directory, returning files to package as extension-relative
 * paths with forward slashes.
 * @param {(rel: string) => boolean} ignored
 * @returns {string[]}
 */
function collectFiles(ignored) {
  const out = [];
  const alwaysSkip = new Set(['.git', 'node_modules', '.build', '.i18n', '.github']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      if (alwaysSkip.has(entry.name)) continue;
      if (ignored(rel)) continue;
      if (entry.isDirectory()) walk(abs);
      else out.push(rel);
    }
  };
  walk(ROOT);
  return out.sort();
}

/**
 * Escape text for use inside an XML attribute or CDATA-safe position.
 * @param {string} s
 * @returns {string}
 */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function main() {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'dist');
  const targetIdx = argv.indexOf('--target');
  const target = targetIdx >= 0 ? argv[targetIdx + 1] : 'universal';

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const ignorePath = path.join(ROOT, '.vscodeignore');
  const ignored = makeIgnoreMatcher(
    fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8').split('\n') : []
  );

  const files = collectFiles(ignored);

  // A .vsix must not ship with the %key% placeholders unresolved — VS Code would show
  // the raw token as the setting description — so resolve every one before building.
  const nlsPath = path.join(ROOT, 'package.nls.json');
  if (!fs.existsSync(nlsPath)) {
    console.error('package.nls.json is missing — run: node scripts/l10n-sync-manifest.js --write');
    process.exit(1);
  }
  const nls = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
  const unresolved = [];
  const scan = (node, prefix) => {
    if (typeof node === 'string') {
      if (node.length > 1 && node[0] === '%' && node.endsWith('%') && !(node.slice(1, -1) in nls)) {
        unresolved.push(prefix + ' -> ' + node);
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, prefix + '.' + i)); return; }
    if (node && typeof node === 'object') for (const k of Object.keys(node)) scan(node[k], prefix ? prefix + '.' + k : k);
  };
  scan(pkg, '');
  if (unresolved.length) {
    console.error('Unresolved %tokens% in package.json:');
    for (const u of unresolved) console.error('  ' + u);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const vsixName = pkg.name + '-' + pkg.version + '.vsix';
  const vsixPath = path.join(outDir, vsixName);
  if (fs.existsSync(vsixPath)) fs.unlinkSync(vsixPath);

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
    <DisplayName>${xmlEscape(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(nls[pkg.description.replace(/%/g, '')] || pkg.description)}</Description>
    <Tags>${xmlEscape((pkg.keywords || []).join(','))}</Tags>
    <Categories>${xmlEscape((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xmlEscape((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape((pkg.repository && pkg.repository.url) || '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="${xmlEscape((pkg.repository && pkg.repository.url) || '')}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="${xmlEscape((pkg.homepage) || (pkg.repository && pkg.repository.url) || '')}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${xmlEscape(pkg.icon || '')}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xmlEscape(pkg.icon || 'media/icon.png')}" Addressable="true" />
  </Assets>
</PackageManifest>
`;

  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".yml" ContentType="text/yaml" />
</Types>
`;

  // Build with Python's zipfile: it is present wherever Node is, and it lets the
  // manifest be stored first, which some installers expect.
  const staging = path.join(outDir, '.vsix-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'extension.vsixmanifest'), manifest, 'utf8');
  fs.writeFileSync(path.join(staging, '[Content_Types].xml'), contentTypes, 'utf8');
  // vsce stores the listing text and licence under fixed lower-case names, and the
  // manifest has to reference exactly what is in the archive: a ZIP is
  // case-sensitive, so `README.md` would not satisfy a reference to `readme.md`.
  const RENAMES = { 'README.md': 'readme.md', LICENSE: 'LICENSE.txt' };
  for (const rel of files) {
    const dest = path.join(staging, 'extension', RENAMES[rel] || rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  for (const [from, to] of Object.entries(RENAMES)) {
    if (!files.includes(from)) {
      console.warn('warning: ' + from + ' not found; the manifest references extension/' + to);
    }
  }

  const py = `
import os, sys, zipfile
staging, out = sys.argv[1], sys.argv[2]
names = []
for dirpath, dirnames, filenames in os.walk(staging):
    dirnames.sort()
    for f in sorted(filenames):
        full = os.path.join(dirpath, f)
        names.append((full, os.path.relpath(full, staging).replace(os.sep, "/")))
# manifest first, then content types, then the payload
order = {"extension.vsixmanifest": 0, "[Content_Types].xml": 1}
names.sort(key=lambda t: (order.get(t[1], 2), t[1]))
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for full, rel in names:
        z.write(full, rel)
print("entries:", len(names))
`;
  const pyFile = path.join(outDir, '.build-vsix.py');
  fs.writeFileSync(pyFile, py, 'utf8');
  const out = execFileSync('python3', [pyFile, staging, vsixPath], { encoding: 'utf8' });
  process.stdout.write(out);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.unlinkSync(pyFile);

  const size = fs.statSync(vsixPath).size;
  console.log('built ' + path.relative(ROOT, vsixPath) + ' (' + (size / 1024).toFixed(1) + ' KB, ' + files.length + ' files)');
  console.log('install with: code --install-extension ' + path.relative(ROOT, vsixPath));
}

main();
