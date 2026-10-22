import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  AGENT_TYPE,
  ingestMcpServersFromConfig,
  isMcpInvokeIngestDue,
  isMcpServerKnown,
  recordMcpInvokeIngestTriggered,
  resolveEntityTypeIds,
  upsertAgent,
  upsertUser,
} from '../src/ingestionClient';
import { osFamily } from '../src/deviceId';
import { RevaConfig } from '../src/types';

const cfg: RevaConfig = {
  rtgUrl: 'https://pdp.test/pdp/v2/ai/evaluation',
  authorization: 'test-token',
  agentId: 'machine-1',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

interface Call {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

function tempDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ingest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function withFetch<T>(
  handler: (call: Call) => { status?: number; body?: any },
  fn: (calls: Call[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const call: Call = {
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers: init?.headers || {},
    };
    calls.push(call);
    const { status = 200, body = {} } = handler(call);
    return new Response(JSON.stringify(body), { status });
  }) as any;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const ENTITY_TYPES = [
  { id: 'user-type', name: 'User', schemaName: 'CodingAgent' },
  { id: 'agent-type', name: 'Agent', schemaName: 'CodingAgent' },
  { id: 'mcp-type', name: 'MCPServer', schemaName: 'CodingAgent' },
];

test('AGENT_TYPE is Codex, not ClaudeCode', () => {
  assert.equal(AGENT_TYPE, 'Codex');
});

test('entity type ids are resolved by name and then cached', async (t) => {
  const dir = tempDir(t);
  await withFetch(
    () => ({ body: ENTITY_TYPES }),
    async (calls) => {
      const first = await resolveEntityTypeIds(cfg, dir);
      assert.deepEqual(first, { userEntityTypeId: 'user-type', agentEntityTypeId: 'agent-type', mcpServerEntityTypeId: 'mcp-type' });
      assert.equal(calls.length, 1);
      // Warm cache: no second round trip.
      const second = await resolveEntityTypeIds(cfg, dir);
      assert.equal(calls.length, 1);
      assert.equal(second.agentEntityTypeId, 'agent-type');
    },
  );
});

test('a partial catalog is not cached as final, so a later session retries', async (t) => {
  const dir = tempDir(t);
  await withFetch(
    () => ({ body: ENTITY_TYPES.filter((e) => e.name !== 'MCPServer') }),
    async (calls) => {
      await resolveEntityTypeIds(cfg, dir);
      await resolveEntityTypeIds(cfg, dir);
      assert.equal(calls.length, 2);
    },
  );
});

test('a failed fetch falls back to whatever was already cached', async (t) => {
  const dir = tempDir(t);
  await withFetch(() => ({ body: ENTITY_TYPES }), async () => {
    await resolveEntityTypeIds(cfg, dir);
  });
  await withFetch(() => ({ status: 500 }), async () => {
    const result = await resolveEntityTypeIds(cfg, dir);
    assert.equal(result.agentEntityTypeId, 'agent-type');
  });
});

test('resolveEntityTypeIds(forceRefresh=true) re-fetches even when the cache is complete', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({ userEntityTypeId: 'old-user', agentEntityTypeId: 'old-agent', mcpServerEntityTypeId: 'old-mcp' }),
    'utf8',
  );
  await withFetch(
    () => ({ body: ENTITY_TYPES }),
    async (calls) => {
      const result = await resolveEntityTypeIds(cfg, dir, true);
      assert.equal(calls.length, 1);
      assert.equal(result.userEntityTypeId, 'user-type');
      const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
      assert.equal(cache.userEntityTypeId, 'user-type');
    },
  );
});

test('a changed entity-type id clears knownMcpServerNames', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({
      userEntityTypeId: 'OLD-user',
      agentEntityTypeId: 'OLD-agent',
      mcpServerEntityTypeId: 'OLD-mcp',
      knownMcpServerNames: ['gmail', 'miro'],
      lastMcpDiscoveryTriggeredAt: 1234,
      lastMcpInvokeIngestAt: 5678,
    }),
    'utf8',
  );
  await withFetch(
    () => ({
      body: [
        { id: 'NEW-user', name: 'User', schemaName: 'CodingAgent' },
        { id: 'NEW-agent', name: 'Agent', schemaName: 'CodingAgent' },
        { id: 'NEW-mcp', name: 'MCPServer', schemaName: 'CodingAgent' },
      ],
    }),
    async () => {
      await resolveEntityTypeIds(cfg, dir, true);
    },
  );
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
  assert.equal(cache.userEntityTypeId, 'NEW-user');
  assert.equal(cache.knownMcpServerNames, undefined);
  assert.equal(cache.lastMcpDiscoveryTriggeredAt, undefined);
  assert.equal(cache.lastMcpInvokeIngestAt, undefined);
});

test('an UNCHANGED force-refresh leaves knownMcpServerNames intact', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({
      userEntityTypeId: 'user-type',
      agentEntityTypeId: 'agent-type',
      mcpServerEntityTypeId: 'mcp-type',
      knownMcpServerNames: ['gmail'],
    }),
    'utf8',
  );
  await withFetch(() => ({ body: ENTITY_TYPES }), async () => {
    await resolveEntityTypeIds(cfg, dir, true);
  });
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
  assert.deepEqual(cache.knownMcpServerNames, ['gmail']);
});

test('only url-bearing MCP servers are ingested; stdio ones are skipped', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['[mcp_servers.remote]', 'url = "https://remote.example.com/mcp"', '[mcp_servers.local]', 'command = "node"'].join('\n'),
    'utf8',
  );
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir);
      const posts = calls.filter((c) => c.method === 'POST');
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].body.attributes, [
        { name: 'description', value: 'MCP server "remote"' },
        { name: 'transport', value: 'http' },
        { name: 'baseUrl', value: 'https://remote.example.com/mcp' },
        { name: 'connectionType', value: 'remote' },
      ]);
    },
  );
});

test('ingestMcpServersFromConfig PATCHes registeredMcpServers only for the remote (url-bearing) server — a stdio one is never ingested at all', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['[mcp_servers.remote]', 'url = "https://remote.example.com/mcp"', '[mcp_servers.local]', 'command = "node"'].join('\n'),
    'utf8',
  );
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com');
      const patches = calls.filter((c) => c.method === 'PATCH');
      assert.equal(patches.length, 1);
      assert.deepEqual(patches[0].body.attributeValue, { name: 'registeredMcpServers', value: 'remote' });
      // No call at all for "local" — not a PATCH, not a POST.
      assert.equal(calls.some((c) => JSON.stringify(c.body).includes('local')), false);
    },
  );
});

test('ingestMcpServersFromConfig never makes any call for a stdio server, even with no known servers yet', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, ['[mcp_servers.local]', 'command = "node"'].join('\n'), 'utf8');
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com');
      assert.equal(calls.length, 0);
    },
  );
});

test('ingestMcpServersFromConfig never PATCHes registeredMcpServers for a server already known from an earlier session', async (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({ knownMcpServerNames: ['remote', 'local'] }),
    'utf8',
  );
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(
    configPath,
    ['[mcp_servers.remote]', 'url = "https://remote.example.com/mcp"', '[mcp_servers.local]', 'command = "node"'].join('\n'),
    'utf8',
  );
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com');
      assert.equal(calls.length, 0);
    },
  );
});

test('ingestMcpServersFromConfig without userEntityTypeId/userEmail never attempts registeredMcpServers', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '[mcp_servers.remote]\nurl = "https://remote.example.com/mcp"\n', 'utf8');
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir);
      assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    },
  );
});

test('a missing config.toml ingests nothing and does not throw', async (t) => {
  const dir = tempDir(t);
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', path.join(dir, 'absent.toml'));
      assert.equal(calls.length, 0);
    },
  );
});

test('ingestMcpServersFromConfig leaves a failed PATCH out of knownMcpServerNames so the next pass retries', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '[mcp_servers.local]\ncommand = "node"\n', 'utf8');
  await withFetch(
    (call) => {
      if (call.method === 'PATCH') return { status: 500, body: { message: 'boom' } };
      return { body: {} };
    },
    async () => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com');
    },
  );
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
  assert.deepEqual(cache.knownMcpServerNames || [], []);
});

test('ingestMcpServersFromConfig ignores an invoked extra server with no url — the only kind ingest-on-invoke ever supplies', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '', 'utf8');
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com', [
        { name: 'claude-browser' },
      ]);
      assert.equal(calls.length, 0);
    },
  );
});

test('ingestMcpServersFromConfig merges an invoked extra server WITH a url into the pass', async (t) => {
  const dir = tempDir(t);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '', 'utf8');
  await withFetch(
    () => ({ body: {} }),
    async (calls) => {
      await ingestMcpServersFromConfig(cfg, 'mcp-type', configPath, dir, 'user-type', 'dev@example.com', [
        { name: 'invoked-remote', url: 'https://invoked-remote.example.com/mcp' },
      ]);
      const patches = calls.filter((c) => c.method === 'PATCH');
      assert.equal(patches.length, 1);
      assert.equal(patches[0].body.attributeValue.value, 'invoked-remote');
    },
  );
});

test('isMcpServerKnown / invoke-ingest throttle helpers', async (t) => {
  const dir = tempDir(t);
  assert.equal(isMcpServerKnown('x', dir), false);
  assert.equal(isMcpInvokeIngestDue(dir), true);
  recordMcpInvokeIngestTriggered(dir);
  assert.equal(isMcpInvokeIngestDue(dir), false);
  fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'entity-types', 'catalog.json'),
    JSON.stringify({ knownMcpServerNames: ['x'], lastMcpInvokeIngestAt: Date.now() }),
    'utf8',
  );
  assert.equal(isMcpServerKnown('x', dir), true);
});


// ---------------------------------------------------------------------------
// GET-then-branch upsert (blueprint 8.2). The whole point is self-healing:
// a live GET every session, never a local "already did this" flag.
// ---------------------------------------------------------------------------

function stateResponder(state: 'found' | 'not-found' | 'inconclusive') {
  return (call: Call) => {
    if (call.method === 'GET' && /\/entity\//.test(call.url)) {
      if (state === 'found') return { status: 200, body: { entityAttributes: [] } };
      if (state === 'not-found') return { status: 404 };
      return { status: 503 };
    }
    return { body: {} };
  };
}

test('User not found -> ONE POST carrying every attribute, Sets included', async () => {
  await withFetch(stateResponder('not-found'), async (calls) => {
    await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1, 'a brand-new entity needs no follow-up PATCH');
    assert.deepEqual(posts[0].body.attributes, [
      { name: 'active', value: 'false' },
      { name: 'registeredMachineIds', value: 'machine-1' },
      { name: 'agents', value: 'account-9' },
    ]);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  });
});

test('User found -> no re-create, and the two Sets take two separate PATCHes', async () => {
  await withFetch(stateResponder('found'), async (calls) => {
    await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'must never re-create');
    const patches = calls.filter((c) => c.method === 'PATCH');
    // One attributeValue per PATCH — there is no confirmed way to ADD to two
    // different Sets in one request.
    assert.deepEqual(
      patches.map((p) => p.body.attributeValue),
      [
        { name: 'registeredMachineIds', value: 'machine-1' },
        { name: 'agents', value: 'account-9' },
      ],
    );
    // `active` is create-only: a human/admin flips it, never the plugin.
    assert.ok(!patches.some((p) => p.body.attributeValue.name === 'active'));
  });
});

test('a 400 on the existence check means not-found, same as a 404', async () => {
  // Some backends answer an unresolvable id with 400 rather than a clean 404.
  await withFetch(
    (call) => (call.method === 'GET' && /\/entity\//.test(call.url) ? { status: 400 } : { body: {} }),
    async (calls) => {
      await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    },
  );
});

test('an inconclusive check assumes the entity exists rather than guessing not-found', async () => {
  // A wrong POST risks a duplicate/conflicting create; a wrong assume-exists
  // costs at most one skipped update that next session retries.
  await withFetch(stateResponder('inconclusive'), async (calls) => {
    await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.ok(calls.some((c) => c.method === 'PATCH'));
  });
});

test('Agent not found -> one POST with user + agentType + optional Sets', async () => {
  await withFetch(stateResponder('not-found'), async (calls) => {
    await upsertAgent(cfg, 'agent-type', 'account-9', 'dev@example.com', 'gpt-5.6-terra');
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.entityId, 'account-9', 'the Agent id is the ACCOUNT, not the machine');
    assert.deepEqual(posts[0].body.attributes, [
      { name: 'user', value: 'dev@example.com' },
      { name: 'agentType', value: 'Codex' },
      { name: 'operatingSystems', value: osFamily() },
      { name: 'models', value: 'gpt-5.6-terra' },
    ]);
  });
});

test('Agent found -> PATCH agentType + each Set, none for the create-only user attribute', async () => {
  await withFetch(stateResponder('found'), async (calls) => {
    await upsertAgent(cfg, 'agent-type', 'account-9', 'dev@example.com', 'gpt-5.6-terra');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.deepEqual(
      calls.filter((c) => c.method === 'PATCH').map((p) => p.body.attributeValue.name),
      ['agentType', 'operatingSystems', 'models'],
    );
  });
});

test('a missing model is omitted, never sent as a placeholder', async () => {
  await withFetch(stateResponder('not-found'), async (calls) => {
    await upsertAgent(cfg, 'agent-type', 'account-9', 'dev@example.com');
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.ok(!post!.body.attributes.some((a: any) => a.name === 'models'));
  });
  await withFetch(stateResponder('found'), async (calls) => {
    await upsertAgent(cfg, 'agent-type', 'account-9', 'dev@example.com');
    assert.deepEqual(
      calls.filter((c) => c.method === 'PATCH').map((p) => p.body.attributeValue.name),
      ['agentType', 'operatingSystems'],
    );
  });
});

test('one rejected Set attribute does not stop the others', async () => {
  await withFetch(
    (call) => {
      if (call.method === 'GET' && /\/entity\//.test(call.url)) return { status: 200, body: {} };
      if (call.body?.attributeValue?.name === 'operatingSystems') return { status: 400 };
      return { body: {} };
    },
    async (calls) => {
      await upsertAgent(cfg, 'agent-type', 'account-9', 'dev@example.com', 'gpt-5.6-terra');
      assert.deepEqual(
        calls.filter((c) => c.method === 'PATCH').map((p) => p.body.attributeValue.name),
        ['agentType', 'operatingSystems', 'models'],
      );
    },
  );
});

test('the existence check is re-run every call — there is no local cache', async () => {
  // The removed signature cache is what broke self-healing: an entity deleted
  // Reva-side was never recreated because a local flag said "already done".
  await withFetch(stateResponder('found'), async (calls) => {
    await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
    await upsertUser(cfg, 'user-type', 'dev@example.com', 'machine-1', 'account-9');
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2);
  });
});
