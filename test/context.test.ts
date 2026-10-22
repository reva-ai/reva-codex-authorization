import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActionContext,
  buildInvokeAgentContext,
  buildToolResponseTransmission,
  buildTransmission,
  osAttribute,
  serializeToolResponse,
} from '../src/context';
import { AGENT_TYPE } from '../src/ingestionClient';
import { CedarActionMapping, CedarHop } from '../src/types';

const session = { sessionId: 'sess-1', entrypoint: 'codex-cli', lastSeen: 1234 };

function mapping(actionName: CedarActionMapping['actionName'], extra: Partial<CedarActionMapping> = {}): CedarActionMapping {
  return { actionName, resourceType: 'File', resourceId: 'repo/a.ts', ...extra };
}

const hop: CedarHop = {
  seq: 1,
  subject: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeAgent' },
  resource: { type: 'Agent', id: 'agent-a' },
  time: '2026-08-19T10:00:00Z',
};

test('agentType is the Codex constant on every action', () => {
  assert.equal(AGENT_TYPE, 'Codex');
  for (const action of ['executeBash', 'write', 'edit', 'invokeTool', 'spawn'] as const) {
    assert.equal(buildActionContext(mapping(action)).agentType, 'Codex');
  }
  assert.equal(buildInvokeAgentContext().agentType, 'Codex');
});

test('prompt is NEVER placed in context — the RTG manages that field and rejects it', () => {
  for (const action of ['executeBash', 'read', 'write', 'edit', 'glob', 'grep', 'invokeTool', 'spawn'] as const) {
    assert.ok(!('prompt' in buildActionContext(mapping(action))), `${action} must not carry prompt`);
  }
  assert.ok(!('prompt' in buildInvokeAgentContext()));
});

test('executeBash carries the real command string', () => {
  const ctx = buildActionContext(mapping('executeBash', { command: 'Get-Content server.js' }));
  assert.equal(ctx.command, 'Get-Content server.js');
});

test('executeBash with no command still sends the declared attribute, empty', () => {
  // The schema declares `command` as required on executeBash, so omitting it
  // would be a schema violation even when the string is empty.
  assert.equal(buildActionContext(mapping('executeBash')).command, '');
});

test('command is sent ONLY on executeBash — closed context per action', () => {
  for (const action of ['read', 'write', 'edit', 'glob', 'grep', 'invokeTool', 'spawn'] as const) {
    const ctx = buildActionContext(mapping(action, { command: 'leaked' }));
    assert.ok(!('command' in ctx), `${action} must not carry command`);
  }
});

test('subagentIndex is sent only on spawn, and defaults to 1', () => {
  assert.equal(buildActionContext(mapping('spawn'), { subagentIndex: 4 }).subagentIndex, 4);
  assert.equal(buildActionContext(mapping('spawn')).subagentIndex, 1);
  for (const action of ['executeBash', 'write', 'edit', 'invokeTool'] as const) {
    assert.ok(!('subagentIndex' in buildActionContext(mapping(action))));
  }
});

test('hops is always present, empty for the first hop of a turn', () => {
  assert.deepEqual(buildActionContext(mapping('write')).hops, []);
  assert.deepEqual(buildActionContext(mapping('write'), { hops: [hop] }).hops, [hop]);
  assert.deepEqual(buildInvokeAgentContext().hops, []);
});

test('conversation is omitted entirely when there is no prompt to report', () => {
  assert.ok(!('conversation' in buildActionContext(mapping('write'))));
  const withPrompt = buildActionContext(mapping('write'), {
    conversationMessages: [
      { seq: 1, role: 'user', contentType: 'text/plain', content: 'hi', timestamp: '2026-08-19T10:00:00Z' },
    ],
  });
  assert.equal(withPrompt.conversation.messages.length, 1);
});

test('session scalars ride on every action, defaulting to empty rather than undefined', () => {
  const ctx = buildActionContext(mapping('write'), { activeSessionCount: 2, currentSession: session });
  assert.equal(ctx.activeSessionCount, 2);
  assert.equal(ctx.sessionId, 'sess-1');
  assert.equal(ctx.sessionEntryPoint, 'codex-cli');
  assert.equal(ctx.sessionLastSeen, 1234);

  const bare = buildActionContext(mapping('write'));
  assert.equal(bare.activeSessionCount, 0);
  assert.equal(bare.sessionId, '');
  assert.equal(bare.sessionEntryPoint, '');
  assert.equal(bare.sessionLastSeen, 0);
});

test('timestamp is epoch milliseconds', () => {
  const before = Date.now();
  const ts = buildActionContext(mapping('write')).timestamp;
  assert.ok(Number.isInteger(ts) && ts >= before);
});

test('transmission uses the canonical direct-AI shape', () => {
  assert.deepEqual(buildTransmission('do the thing', 'user'), {
    promptKey: 'userQuery',
    userQuery: 'do the thing',
    role: 'user',
    contentType: 'text/plain',
  });
});

test('a blank transmission falls back, and an entirely blank one throws', () => {
  assert.equal(buildTransmission('   ', 'assistant', 'Bash').userQuery, 'Bash');
  assert.throws(() => buildTransmission('', 'assistant', '   '), /nonblank current prompt/);
});

test('buildToolResponseTransmission keeps the PreToolUse query in userQuery and puts a structured tool_response in response', () => {
  const transmission = buildToolResponseTransmission({ ok: true }, 'apply_patch');
  assert.equal(transmission.role, 'tool');
  assert.equal(transmission.promptKey, 'userQuery');
  assert.equal(transmission.contentType, 'text/plain');
  assert.equal(transmission.userQuery, 'apply_patch');
  assert.equal(transmission.response, '{"ok":true}');
});

test('buildToolResponseTransmission keeps a string tool_response in response and the original query in userQuery', () => {
  const transmission = buildToolResponseTransmission('done', 'apply_patch');
  assert.equal(transmission.contentType, 'text/plain');
  assert.equal(transmission.userQuery, 'apply_patch');
  assert.equal(transmission.response, 'done');
});

test('serializeToolResponse treats null/undefined as empty string', () => {
  assert.equal(serializeToolResponse(undefined), '');
  assert.equal(serializeToolResponse(null), '');
  const transmission = buildToolResponseTransmission(null, 'apply_patch');
  assert.equal(transmission.userQuery, 'apply_patch');
  assert.equal(transmission.response, '');
});

test('an oversized tool response is truncated to 10000 characters plus an ellipsis', () => {
  assert.equal(serializeToolResponse('y'.repeat(10000)), 'y'.repeat(10000));
  assert.equal(serializeToolResponse('y'.repeat(10001)), `${'y'.repeat(10000)}…`);
});


test('model is NOT sent unless modelContext is enabled', () => {
  // Cedar context is closed: an undeclared attribute returns 4xx, which this
  // plugin treats as a real denial. Default-off keeps it safe to ship before
  // the schema lands.
  for (const action of ['executeBash', 'write', 'edit', 'invokeTool', 'spawn'] as const) {
    const ctx = buildActionContext(mapping(action), { model: 'gpt-5.6-terra' });
    assert.ok(!('model' in ctx), `${action} must not carry model by default`);
  }
  assert.ok(!('model' in buildInvokeAgentContext(1, session, { model: 'gpt-5.6-terra' })));
});

test('with modelContext, model rides on every action beside agentType', () => {
  for (const action of ['executeBash', 'write', 'edit', 'invokeTool', 'spawn'] as const) {
    const ctx = buildActionContext(mapping(action), { model: 'gpt-5.6-terra', modelContext: true });
    assert.equal(ctx.model, 'gpt-5.6-terra');
    assert.equal(ctx.agentType, 'Codex');
  }
});

test('invokeAgent carries model too, so every action in a turn agrees', () => {
  const ctx = buildInvokeAgentContext(1, session, { model: 'gpt-5.6-terra', modelContext: true });
  assert.equal(ctx.model, 'gpt-5.6-terra');
});

test('a missing model is sent as empty rather than guessed', () => {
  assert.equal(buildActionContext(mapping('executeBash'), { modelContext: true }).model, '');
});

test('osAttribute is a command-dialect distinction, not literal kernel identity — every Unix-like platform is "Linux", only win32 is "Windows"', () => {
  assert.equal(osAttribute('win32'), 'Windows');
  for (const unixLike of ['linux', 'darwin', 'freebsd', 'openbsd', 'aix', 'sunos'] as const) {
    assert.equal(osAttribute(unixLike), 'Linux', `${unixLike} uses the same POSIX shell commands as Linux`);
  }
});

test('os and machineId are present on every action', () => {
  const expectedOs = osAttribute();
  const ctx = buildActionContext(mapping('write'), { machineId: 'machine-abc' });
  assert.equal(ctx.os, expectedOs);
  assert.equal(ctx.machineId, 'machine-abc');

  const invoke = buildInvokeAgentContext(1, session, { machineId: 'machine-abc' });
  assert.equal(invoke.os, expectedOs);
  assert.equal(invoke.machineId, 'machine-abc');
});

test('machineId defaults to empty when not provided', () => {
  assert.equal(buildActionContext(mapping('write')).machineId, '');
  assert.equal(buildInvokeAgentContext().machineId, '');
});
