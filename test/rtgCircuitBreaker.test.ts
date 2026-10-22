import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { isCircuitOpen, openCircuit } from '../src/rtgCircuitBreaker';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-circuit-breaker-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Matches rtgCircuitBreaker.ts's own (unexported) cacheFile() convention —
// needed here only to hand-write a malformed or backdated entry.
function cacheFile(dir: string, sessionId: string): string {
  return path.join(dir, 'rtg-circuit-breaker', `${sessionId}.json`);
}

test('a session that has never seen a 401 is closed', () => {
  withTempDir((dir) => {
    assert.equal(isCircuitOpen('sess-1', dir).open, false);
  });
});

test('openCircuit latches that session, carrying status and errorType through', () => {
  withTempDir((dir) => {
    openCircuit('sess-1', 401, 'UNAUTHORIZED', dir);
    const status = isCircuitOpen('sess-1', dir);
    assert.equal(status.open, true);
    assert.equal(status.triggeredStatus, 401);
    assert.equal(status.errorType, 'UNAUTHORIZED');
    assert.ok(status.openedAt! <= Date.now());
  });
});

test('the latch NEVER expires — openedAt is recorded but never compared to the clock', () => {
  withTempDir((dir) => {
    // Backdated a year. Under the old 4-hour window this would have reopened
    // the circuit; a session latch has no expiry at all.
    const file = cacheFile(dir, 'sess-old');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ openedAt: Date.now() - 365 * 24 * 60 * 60 * 1000, triggeredStatus: 401, errorType: 'UNAUTHORIZED' }),
      'utf8',
    );
    assert.equal(isCircuitOpen('sess-old', dir).open, true, 'a latched session stays latched for good');
  });
});

test('a DIFFERENT session is unaffected — this is the recovery path', () => {
  withTempDir((dir) => {
    openCircuit('sess-broken', 401, 'UNAUTHORIZED', dir);
    assert.equal(isCircuitOpen('sess-broken', dir).open, true);
    // The whole point of session scoping: the user restarts, gets a new
    // session id, and the plugin calls the RTG again immediately. Under the
    // old agent-keyed window this session would have been silenced too.
    assert.equal(isCircuitOpen('sess-fresh', dir).open, false);
  });
});

test('a second 401 in the same session is idempotent', () => {
  withTempDir((dir) => {
    openCircuit('sess-1', 401, 'UNAUTHORIZED', dir);
    const first = isCircuitOpen('sess-1', dir).openedAt;
    openCircuit('sess-1', 401, 'UNAUTHORIZED', dir);
    const second = isCircuitOpen('sess-1', dir);
    assert.equal(second.open, true);
    assert.ok(second.openedAt! >= first!);
  });
});

test('an unreadable latch reads as CLOSED, so the RTG is called rather than skipped', () => {
  withTempDir((dir) => {
    const file = cacheFile(dir, 'sess-corrupt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');
    // Erring toward MAKING the governance call is the safer direction — a
    // latch we cannot read is not evidence that we should stop checking.
    assert.equal(isCircuitOpen('sess-corrupt', dir).open, false);
  });
});

test('with no pluginDataDir nothing is written and nothing reads as open', () => {
  openCircuit('sess-1', 401, 'UNAUTHORIZED', undefined);
  assert.equal(isCircuitOpen('sess-1', undefined).open, false);
});

test('an empty session id never latches', () => {
  withTempDir((dir) => {
    openCircuit('', 401, 'UNAUTHORIZED', dir);
    assert.equal(isCircuitOpen('', dir).open, false);
  });
});

test('latches older than the 30-day stale window are swept on the next write', () => {
  withTempDir((dir) => {
    const old = cacheFile(dir, 'sess-ancient');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, JSON.stringify({ openedAt: 0, triggeredStatus: 401 }), 'utf8');
    const longAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

    openCircuit('sess-new', 401, 'UNAUTHORIZED', dir);
    assert.equal(fs.existsSync(old), false, 'stale latch removed');
    assert.equal(isCircuitOpen('sess-new', dir).open, true, 'the new one survives');
  });
});
