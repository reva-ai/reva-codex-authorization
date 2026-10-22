import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triggerMcpDiscoveryIfDue, triggerMcpIngestionForInvokedServer } from '../src/mcpIngestionTrigger';

test('triggerMcpDiscoveryIfDue does nothing when not due — no record, no spawn', () => {
  let recorded = false;
  let spawned = false;
  triggerMcpDiscoveryIfDue(
    '/some/cwd',
    'plugin-data-dir',
    () => false,
    () => {
      recorded = true;
    },
    () => {
      spawned = true;
    },
  );
  assert.equal(recorded, false);
  assert.equal(spawned, false);
});

test('triggerMcpDiscoveryIfDue records the trigger, then spawns, when due', () => {
  const calls: string[] = [];
  let spawnArgs: { cwd: string; pluginDataDir?: string } | undefined;
  triggerMcpDiscoveryIfDue(
    '/some/cwd',
    'plugin-data-dir',
    () => true,
    () => {
      calls.push('recorded');
    },
    (cwd, pluginDataDir) => {
      calls.push('spawned');
      spawnArgs = { cwd, pluginDataDir };
    },
  );
  assert.deepEqual(calls, ['recorded', 'spawned']);
  assert.deepEqual(spawnArgs, { cwd: '/some/cwd', pluginDataDir: 'plugin-data-dir' });
});

test('triggerMcpIngestionForInvokedServer does nothing for a server already ingested', () => {
  const calls: string[] = [];
  let dueChecked = false;
  triggerMcpIngestionForInvokedServer(
    'gmail',
    '/repo',
    '/data',
    () => true,
    () => {
      dueChecked = true;
      return true;
    },
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
  assert.equal(dueChecked, false);
});

test('triggerMcpIngestionForInvokedServer records then spawns for an unknown server', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    'brand-new-server',
    '/repo',
    '/data',
    () => false,
    () => true,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, ['record', 'spawn']);
});

test('triggerMcpIngestionForInvokedServer respects the throttle for an unknown server', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    'brand-new-server',
    '/repo',
    '/data',
    () => false,
    () => false,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
});

test('triggerMcpIngestionForInvokedServer ignores an empty server name', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    '',
    '/repo',
    '/data',
    () => false,
    () => true,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
});

test('the invoked server name is handed to the spawned child', () => {
  const seen: Record<string, unknown> = {};
  triggerMcpIngestionForInvokedServer(
    'claude-browser',
    '/some/cwd',
    '/some/data',
    () => false,
    () => true,
    () => {},
    (cwd, dir, invokedServer) => {
      seen.cwd = cwd;
      seen.dir = dir;
      seen.invokedServer = invokedServer;
    },
  );
  assert.equal(seen.invokedServer, 'claude-browser');
  assert.equal(seen.cwd, '/some/cwd');
  assert.equal(seen.dir, '/some/data');
});
