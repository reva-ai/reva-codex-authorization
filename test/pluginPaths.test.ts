import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveDataDir, safeFileName, stateDir } from '../src/pluginPaths';

test('PLUGIN_DATA is preferred — it is the real Codex variable', () => {
  assert.equal(resolveDataDir({ PLUGIN_DATA: '/data/codex' }), '/data/codex');
});

test('CLAUDE_PLUGIN_DATA is accepted as the compatibility alias Codex also sets', () => {
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/data/compat' }), '/data/compat');
  // When both are present the real name wins.
  assert.equal(resolveDataDir({ PLUGIN_DATA: '/data/real', CLAUDE_PLUGIN_DATA: '/data/compat' }), '/data/real');
});

test('a hand-registered hooks.json gets neither variable and falls back to the home directory', () => {
  // Codex injects PLUGIN_DATA only for plugin-bundled hooks; discovery
  // passes an empty env for every other source, so this is a real path.
  const fallback = resolveDataDir({});
  assert.equal(fallback, path.join(os.homedir(), '.codex-governance'));
  assert.equal(resolveDataDir({ PLUGIN_DATA: '   ' }), fallback);
});

test('the fallback is NOT shared with a Reva plugin for a different host', () => {
  // Sharing it would make each plugin count the other's sessions, changing
  // the activeSessionCount a Cedar policy sees.
  assert.ok(!resolveDataDir({}).includes('.reva-governance'));
});

test('stateDir nests under the resolved data directory', () => {
  assert.equal(stateDir('turns', '/data/codex'), path.join('/data/codex', 'turns'));
});

test('safeFileName strips anything that could escape the cache directory', () => {
  assert.equal(safeFileName('../../etc/passwd'), '______etc_passwd');
  assert.equal(safeFileName('sess-1_ok'), 'sess-1_ok');
  assert.equal(safeFileName('C:\\Users\\x'), 'C__Users_x');
});
