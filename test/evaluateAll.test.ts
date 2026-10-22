import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAll } from '../src/evaluateAll';
import { CedarActionMapping, CedarRequest, RevaConfig } from '../src/types';

const cfg: RevaConfig = {
  rtgUrl: 'https://pdp.test/pdp/v2/ai/evaluation',
  authorization: 'test-token',
  agentId: 'agent-a',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

function mappingFor(id: string): CedarActionMapping {
  return { actionName: 'executeBash', resourceType: 'File', resourceId: id, command: 'Get-Content x' };
}

function requestFor(id: string): CedarRequest {
  return {
    subject: { type: 'Agent', id: 'agent-a' },
    principal: { type: 'User', id: 'alice@example.com' },
    action: { name: 'executeBash' },
    resource: { type: 'File', id },
    context: { timestamp: 1, hops: [] },
    transmission: { promptKey: 'userQuery', userQuery: 'x', role: 'assistant', contentType: 'text/plain' },
    session: { id: 'sess-1', turn: 1, startedAt: '2026-08-19T10:00:00Z' },
  };
}

function batch(ids: string[]): { mapping: CedarActionMapping; request: CedarRequest }[] {
  return ids.map((id) => ({ mapping: mappingFor(id), request: requestFor(id) }));
}

// Responds per-resource, keyed by the resource id in the outgoing body.
async function withFetchByResource<T>(
  statusFor: Record<string, { status: number; body?: any }>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const spec = statusFor[body.resource.id] ?? { status: 200 };
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status });
  }) as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('all allow => allow', async () => {
  await withFetchByResource({ a: { status: 200 }, b: { status: 200 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
    assert.equal(result.outcome, 'allow');
    assert.equal(result.evaluated.length, 2);
  });
});

test('any deny denies the whole call, even when every other resource allows', async () => {
  await withFetchByResource(
    {
      a: { status: 200 },
      b: { status: 403, body: { context: { reason: 'forbidden path' } } },
      c: { status: 200 },
    },
    async () => {
      const result = await evaluateAll(cfg, batch(['a', 'b', 'c']), '00-x-y-01');
      assert.equal(result.outcome, 'deny');
      // The offending resource must be named — with N resources per call a
      // bare "denied" gives no way to tell which path was the problem.
      assert.match(result.reason || '', /Blocked by your organization's security policy/);
      assert.match(result.reason || '', /File:b/);
      assert.match(result.reason || '', /3 resources evaluated/);
      assert.match(result.reason || '', /File:b/);
      assert.match(result.reason || '', /3 resources evaluated/);
    },
  );
});

test('a deny on the LAST resource still denies (order must not matter)', async () => {
  await withFetchByResource({ a: { status: 200 }, b: { status: 200 }, c: { status: 403 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b', 'c']), '00-x-y-01');
    assert.equal(result.outcome, 'deny');
    assert.match(result.reason || '', /File:c/);
  });
});

test('deny outranks ask', async () => {
  await withFetchByResource(
    {
      a: { status: 200, body: { guardrails: { outcome: 'conditional_allow', reason: 'needs review' } } },
      b: { status: 403 },
    },
    async () => {
      const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
      assert.equal(result.outcome, 'deny');
    },
  );
});

test('a conditional_allow with no deny surfaces as ask, naming the resource', async () => {
  await withFetchByResource(
    {
      a: { status: 200 },
      b: { status: 200, body: { guardrails: { outcome: 'conditional_allow', reason: 'needs review' } } },
    },
    async () => {
      const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
      assert.equal(result.outcome, 'ask');
      assert.match(result.reason || '', /needs review/);
      assert.match(result.reason || '', /File:b/);
    },
  );
});

test('every resource inactive => inactive (pass through, no opinion)', async () => {
  await withFetchByResource({ a: { status: 401 }, b: { status: 413 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
    assert.equal(result.outcome, 'inactive');
  });
});

test('an inactive resource neither blocks nor satisfies: a real deny beside it still denies', async () => {
  await withFetchByResource({ a: { status: 401 }, b: { status: 403 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
    assert.equal(result.outcome, 'deny');
  });
});

test('an inactive resource beside a real allow yields allow, not inactive', async () => {
  await withFetchByResource({ a: { status: 401 }, b: { status: 200 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
    assert.equal(result.outcome, 'allow');
  });
});

test('a fail-closed 5xx denies the whole call (not inactive)', async () => {
  await withFetchByResource({ a: { status: 503 }, b: { status: 200 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a', 'b']), '00-x-y-01');
    assert.equal(result.outcome, 'deny');
  });
});

test('resources are evaluated in parallel, not sequentially', async () => {
  const original = globalThis.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return new Response('{}', { status: 200 });
  }) as any;
  try {
    await evaluateAll(cfg, batch(['a', 'b', 'c', 'd']), '00-x-y-01');
    assert.equal(maxInFlight, 4, `expected 4 concurrent requests, saw ${maxInFlight}`);
  } finally {
    globalThis.fetch = original;
  }
});

test('a single resource produces no misleading multi-resource wording', async () => {
  await withFetchByResource({ a: { status: 403 } }, async () => {
    const result = await evaluateAll(cfg, batch(['a']), '00-x-y-01');
    assert.equal(result.outcome, 'deny');
    assert.ok(!/resources evaluated/.test(result.reason || ''));
  });
});
