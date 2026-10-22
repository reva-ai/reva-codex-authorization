import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  conversationFromTurn,
  directSessionFromTurn,
  loadOrStartTurn,
  loadTurn,
  startTurn,
  truncatePrompt,
} from '../src/turnCache';

function tempDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the first turn is turn 1 and records the prompt against its turn_id', (t) => {
  const dir = tempDir(t);
  const entry = startTurn('sess-1', 'turn-a', 'add a login form', dir);
  assert.equal(entry.turn, 1);
  assert.equal(entry.turnId, 'turn-a');
  assert.equal(entry.prompt, 'add a login form');
});

test('a new turn_id advances the ordinal but preserves startedAt', (t) => {
  const dir = tempDir(t);
  const first = startTurn('sess-1', 'turn-a', 'one', dir);
  const second = startTurn('sess-1', 'turn-b', 'two', dir);
  assert.equal(second.turn, 2);
  assert.equal(second.startedAt, first.startedAt);
});

test('a repeated UserPromptSubmit for the SAME turn_id does not advance the ordinal', (t) => {
  const dir = tempDir(t);
  startTurn('sess-1', 'turn-a', 'one', dir);
  const again = startTurn('sess-1', 'turn-a', 'one', dir);
  assert.equal(again.turn, 1);
});

test('a tool hook in the same turn reads back the prompt UserPromptSubmit recorded', (t) => {
  const dir = tempDir(t);
  startTurn('sess-1', 'turn-a', 'add a login form', dir);
  const fromTool = loadOrStartTurn('sess-1', 'turn-a', dir);
  assert.equal(fromTool.prompt, 'add a login form');
  assert.equal(fromTool.turn, 1);
  assert.deepEqual(conversationFromTurn(fromTool).map((m) => m.content), ['add a login form']);
});

test('a tool hook in a DIFFERENT turn drops the stale prompt rather than fabricating history', (t) => {
  const dir = tempDir(t);
  startTurn('sess-1', 'turn-a', 'previous turn prompt', dir);
  const next = loadOrStartTurn('sess-1', 'turn-b', dir);
  assert.equal(next.turn, 2);
  assert.equal(next.prompt, undefined);
  // No conversation evidence beats wrong conversation evidence.
  assert.deepEqual(conversationFromTurn(next), []);
});

test('a tool hook with no prior UserPromptSubmit records itself as the observed turn', (t) => {
  const dir = tempDir(t);
  const entry = loadOrStartTurn('sess-cold', 'turn-x', dir);
  assert.equal(entry.turn, 1);
  assert.equal(entry.turnId, 'turn-x');
  assert.deepEqual(conversationFromTurn(entry), []);
});

test('sessions are isolated from each other', (t) => {
  const dir = tempDir(t);
  startTurn('sess-1', 'turn-a', 'one', dir);
  startTurn('sess-2', 'turn-a', 'two', dir);
  assert.equal(loadTurn('sess-1', dir)?.prompt, 'one');
  assert.equal(loadTurn('sess-2', dir)?.prompt, 'two');
});

test('a session id with path separators cannot escape the cache directory', (t) => {
  const dir = tempDir(t);
  startTurn('../../evil', 'turn-a', 'x', dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'turns')), ['______evil.json']);
});

test('directSessionFromTurn carries the real turn number and startedAt', (t) => {
  const dir = tempDir(t);
  startTurn('sess-1', 'turn-a', 'one', dir);
  const entry = startTurn('sess-1', 'turn-b', 'two', dir);
  const session = directSessionFromTurn('sess-1', entry);
  assert.deepEqual(session, { id: 'sess-1', turn: 2, startedAt: entry.startedAt });
});

test('an unreadable cache degrades to a fresh turn instead of throwing', () => {
  const entry = loadOrStartTurn('sess-1', 'turn-a', path.join(os.tmpdir(), 'reva-nonexistent-9z', 'nested'));
  assert.equal(entry.turn, 1);
});

test('a prompt of up to 10000 characters is kept whole', () => {
  const prompt = 'x'.repeat(10000);
  assert.equal(truncatePrompt(prompt), prompt);
});

test('a longer prompt is truncated to 10000 characters with an ellipsis', () => {
  const truncated = truncatePrompt('x'.repeat(10001));
  assert.equal(truncated, `${'x'.repeat(10000)}…`);
});
