import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

// Guards the install surface: what Codex needs to find in a fresh copy of
// this repository. The tests run from dist/test, so the repo root is two up.

const root = path.resolve(__dirname, '../..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

test('dist/src is not gitignored — hooks run the committed build, nothing builds on install', () => {
  const ignored = fs
    .readFileSync(path.join(root, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^\//, ''))
    .filter((l) => l && !l.startsWith('#'));
  for (const pattern of ['dist', 'dist/', 'dist/*', 'dist/src', 'dist/src/', 'dist/src/*', 'dist/**']) {
    assert.ok(!ignored.includes(pattern), `.gitignore must not exclude dist/src (found "${pattern}")`);
  }
});

test('every script hooks.json runs exists in dist/src', () => {
  const doc = readJson('hooks/hooks.json');
  const handlers = Object.values(doc.hooks as Record<string, any[]>).flatMap((groups) =>
    groups.flatMap((g) => g.hooks as any[]),
  );
  for (const h of handlers) {
    const script = /\$PLUGIN_ROOT\/(dist\/src\/\w+\.js)/.exec(h.command)?.[1];
    assert.ok(script, `cannot find a dist script in: ${h.command}`);
    assert.ok(fs.existsSync(path.join(root, script)), `${script} is missing — run npm run build and commit dist/src`);
  }
});

// Codex reads the marketplace catalog from .agents/plugins/marketplace.json.
// scripts/publish-to-github.sh excludes the rest of .agents/ but must keep this
// file, or `codex plugin marketplace add <git url>` finds no catalog.
const MARKETPLACE = '.agents/plugins/marketplace.json';

test('the marketplace catalog is at the path Codex reads', () => {
  assert.ok(fs.existsSync(path.join(root, MARKETPLACE)), `${MARKETPLACE} is missing`);
});

test('plugin, package and marketplace versions agree', () => {
  const version = readJson('package.json').version;
  assert.equal(readJson('.codex-plugin/plugin.json').version, version);
  const market = readJson(MARKETPLACE);
  assert.equal(market.metadata.version, version, 'marketplace metadata.version');
  assert.equal(market.plugins[0].version, version, 'marketplace plugins[0].version');
});

test('the marketplace names the plugin the install commands use', () => {
  const market = readJson(MARKETPLACE);
  assert.equal(market.name, 'reva-plugins');
  assert.equal(market.plugins[0].name, readJson('.codex-plugin/plugin.json').name);
  assert.equal(market.plugins[0].source, './');
});

test('the plugin icons exist, resolve inside the plugin root, and are plain SVG', () => {
  const ui = readJson('.codex-plugin/plugin.json').interface;
  for (const field of ['composerIcon', 'logo']) {
    const rel: string = ui[field];
    assert.match(rel, /^\.\/assets\/[\w.-]+\.svg$/, `interface.${field} must be a ./assets/*.svg path`);
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `interface.${field} points at a missing file: ${rel}`);
    const svg = fs.readFileSync(file, 'utf8');
    assert.match(svg, /^\s*<svg[\s>]/, `${rel} is not an SVG document`);
    // An icon is data, not a program: nothing that runs or fetches.
    assert.doesNotMatch(svg, /<script|\bon\w+\s*=|(?:xlink:)?href\s*=|<image\b|@import/i, `${rel} must be self-contained and inert`);
  }
});
