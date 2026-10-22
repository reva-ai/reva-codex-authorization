import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { nextSpawnIndex, resetSpawnCounter } from '../src/spawnCounter';

const execFileAsync = promisify(execFile);
const SPAWN_ONCE_SCRIPT = path.join(__dirname, 'support', 'spawnOnce.js');

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-spawn-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('first spawn in a session is index 1', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
  });
});

test('successive spawns in the same session increment', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
    assert.equal(nextSpawnIndex('sess-1', dir), 3);
  });
});

test('different sessions have independent counters', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    assert.equal(nextSpawnIndex('sess-a', dir), 2);
    assert.equal(nextSpawnIndex('sess-b', dir), 1);
  });
});

test('resetSpawnCounter brings the next spawn back to index 1 — a new turn is not a continuation of the last', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
    assert.equal(nextSpawnIndex('sess-1', dir), 3);
    resetSpawnCounter('sess-1', dir);
    assert.equal(nextSpawnIndex('sess-1', dir), 1);
    assert.equal(nextSpawnIndex('sess-1', dir), 2);
  });
});

test('resetSpawnCounter on a session that never spawned anything is a harmless no-op', () => {
  withTempDir((dir) => {
    resetSpawnCounter('sess-never-spawned', dir);
    assert.equal(nextSpawnIndex('sess-never-spawned', dir), 1);
  });
});

test('resetSpawnCounter only affects the given session, not others', () => {
  withTempDir((dir) => {
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    assert.equal(nextSpawnIndex('sess-a', dir), 2);
    assert.equal(nextSpawnIndex('sess-b', dir), 1);
    assert.equal(nextSpawnIndex('sess-b', dir), 2);
    resetSpawnCounter('sess-a', dir);
    assert.equal(nextSpawnIndex('sess-a', dir), 1);
    // sess-b is untouched by resetting sess-a
    assert.equal(nextSpawnIndex('sess-b', dir), 3);
  });
});

test('concurrent spawns from real, separate processes never produce a duplicate or skipped index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-spawn-race-'));
  try {
    const CONCURRENCY = 12;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => execFileAsync('node', [SPAWN_ONCE_SCRIPT, 'sess-race', dir])),
    );
    const indices = results.map((r) => Number(r.stdout)).sort((a, b) => a - b);
    assert.deepEqual(indices, Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
