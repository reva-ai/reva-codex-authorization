import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSessionContext, buildTraceId, deriveSpanId, toolSpanKey, traceparentHeader } from '../src/trace';

const TOOL_KEY = 'tool:Bash:{"command":"npm test"}';
const OTHER_KEY = 'tool:Bash:{"command":"npm run build"}';

test('traceId is deterministic per turn_id and 32 hex characters', () => {
  // Codex hands every turn-scoped hook the same turn_id, so separate
  // processes reach the identical TRACE independently — no mint, no cache.
  const id = buildTraceId('turn-abc');
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, buildTraceId('turn-abc'));
  assert.notEqual(id, buildTraceId('turn-def'));
});

test('a derived span id is a well-formed W3C span id', () => {
  assert.match(deriveSpanId(buildTraceId('turn-a'), TOOL_KEY), /^[0-9a-f]{16}$/);
});

test('PreToolUse and PostToolUse of ONE tool call land on the same span', () => {
  // The whole reason the span is derived rather than random: the two hooks
  // are separate processes with no shared state, but both see identical
  // tool_name and tool_input, so both compute the same span.
  const traceId = buildTraceId('turn-a');
  assert.equal(deriveSpanId(traceId, TOOL_KEY), deriveSpanId(traceId, TOOL_KEY));
});

test('different tool calls in the same turn get different spans, under one trace', () => {
  const traceId = buildTraceId('turn-a');
  const first = deriveSpanId(traceId, TOOL_KEY);
  const second = deriveSpanId(traceId, OTHER_KEY);
  const prompt = deriveSpanId(traceId, 'user-prompt');
  assert.notEqual(first, second);
  assert.notEqual(first, prompt);
  assert.notEqual(second, prompt);
  for (const span of [first, second, prompt]) {
    assert.equal(traceparentHeader(traceId, span).split('-')[1], traceId);
  }
});

test('the same tool call under a DIFFERENT turn gets a different span', () => {
  assert.notEqual(deriveSpanId(buildTraceId('turn-a'), TOOL_KEY), deriveSpanId(buildTraceId('turn-b'), TOOL_KEY));
});

test('traceparent is a valid W3C header', () => {
  const traceId = buildTraceId('turn-abc');
  const spanId = deriveSpanId(traceId, TOOL_KEY);
  assert.equal(traceparentHeader(traceId, spanId), `00-${traceId}-${spanId}-01`);
  assert.match(traceparentHeader(traceId, spanId), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('two turns get different traces; one session context carries the turn\'s trace', () => {
  const a = buildSessionContext('sess-1', deriveSpanId(buildTraceId('turn-a'), 'user-prompt'), buildTraceId('turn-a'));
  const b = buildSessionContext('sess-1', deriveSpanId(buildTraceId('turn-b'), 'user-prompt'), buildTraceId('turn-b'));
  assert.notEqual(a.traceId, b.traceId);
  assert.notEqual(a.spanId, b.spanId);
  assert.equal(a.id, 'sess-1');
});

test('session context id defaults to the session id and can be overridden', () => {
  const traceId = buildTraceId('turn-a');
  assert.equal(buildSessionContext('sess-1', 'aaaaaaaaaaaaaaaa', traceId).id, 'sess-1');
  assert.equal(buildSessionContext('sess-1', 'aaaaaaaaaaaaaaaa', traceId, 'other').id, 'other');
  assert.equal(buildSessionContext('sess-1', 'aaaaaaaaaaaaaaaa', traceId).traceId, traceId);
});

test('toolSpanKey: each resource of one tool call gets its own key', () => {
  const input = { command: 'cd /repo && rm test.js' };
  const dir = toolSpanKey('Bash', input, { actionName: 'executeBash', resourceId: 'repo' });
  const file = toolSpanKey('Bash', input, { actionName: 'executeBash', resourceId: 'repo/test.js' });
  assert.notEqual(dir, file);
  const traceId = buildTraceId('turn-a');
  assert.notEqual(deriveSpanId(traceId, dir), deriveSpanId(traceId, file));
});

test('toolSpanKey: stable for the same input, so pre and post meet on one span', () => {
  // PreToolUse and PostToolUse build the key in separate processes.
  const mapping = { actionName: 'executeBash', resourceId: 'repo/a.txt' };
  assert.equal(
    toolSpanKey('Bash', { command: 'cat a.txt' }, mapping),
    toolSpanKey('Bash', { command: 'cat a.txt' }, { ...mapping }),
  );
  assert.equal(toolSpanKey('Bash', undefined, mapping), toolSpanKey('Bash', {}, mapping));
});

test('toolSpanKey: differs by action for the same path', () => {
  const input = { patch: '...' };
  assert.notEqual(
    toolSpanKey('apply_patch', input, { actionName: 'write', resourceId: 'repo/a.ts' }),
    toolSpanKey('apply_patch', input, { actionName: 'edit', resourceId: 'repo/a.ts' }),
  );
});
