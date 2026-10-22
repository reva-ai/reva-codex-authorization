import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { evaluate } from '../src/rtgClient';
import { CedarRequest, RevaConfig } from '../src/types';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-rtg-client-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const baseCfg: RevaConfig = {
  rtgUrl: 'https://pdp.test/pdp/v2/ai/evaluation',
  authorization: 'test-token',
  agentId: 'agent-a',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

const baseRequest: CedarRequest = {
  subject: { type: 'Agent', id: 'agent-a' },
  principal: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeTool' },
  resource: { type: 'Tool', id: 'WebFetch', properties: { name: 'WebFetch' } },
  context: {
    timestamp: 1,
    prompt: 'find docs',
    hops: [
      {
        seq: 1,
        subject: { type: 'User', id: 'alice@example.com' },
        action: { name: 'invokeAgent' },
        resource: { type: 'Agent', id: 'agent-a' },
        time: '2026-08-19T10:00:00Z',
      },
    ],
  },
  transmission: {
    promptKey: 'userQuery',
    userQuery: 'WebFetch',
    role: 'assistant',
    contentType: 'text/plain',
  },
  session: { id: 'sess-1', turn: 1, startedAt: '2026-08-19T10:00:00Z' },
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('200 always allows by status, even with decision false or malformed JSON', async () => {
  for (const body of [JSON.stringify({ decision: false }), 'not-json']) {
    await withFetch(
      (async () => new Response(body, { status: 200 })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'allow');
        assert.equal(result.status, 200);
      },
    );
  }
});

test('200 with guardrails.outcome "conditional_allow" asks instead of allowing, using guardrails.reason', async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          decision: true,
          threadId: 'test-session',
          guardrails: {
            status: 'complete',
            outcome: 'conditional_allow',
            health: 'ok',
            reason: 'Synchronous enforce guardrails conditionally allowed the request.',
          },
        }),
        { status: 200 },
      )) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'ask');
      assert.equal(result.status, 200);
      assert.equal(result.reason, 'Synchronous enforce guardrails conditionally allowed the request.');
    },
  );
});

test('200 with guardrails.outcome "conditional_allow" but no reason falls back to a default', async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ decision: true, guardrails: { outcome: 'conditional_allow' } }), {
        status: 200,
      })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'ask');
      assert.ok(result.reason);
    },
  );
});

test('200 with a guardrails block but a different (or absent) outcome still allows', async () => {
  for (const body of [
    JSON.stringify({ decision: true, guardrails: { outcome: 'allow' } }),
    JSON.stringify({ decision: true, guardrails: {} }),
    JSON.stringify({ decision: true }),
  ]) {
    await withFetch(
      (async () => new Response(body, { status: 200 })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'allow');
      },
    );
  }
});

test('403 remains a blocking policy deny, always uses the fixed message regardless of context.reason', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ context: { reason: 'policy denied' } }), { status: 403 });
    }) as any,
    async () => {
      const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(first.decision, 'deny');
      assert.equal(first.status, 403);
      assert.equal(first.reason, "Blocked by your organization's security policy.");
      assert.equal(second.decision, 'deny');
      assert.equal(calls, 2);
    },
  );
});

test('every 401 error type fails open, every call, with no persistence when pluginDataDir is unset', async () => {
  for (const errorType of ['USER_DISABLED', 'USER_NOT_FOUND']) {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: errorType }), { status: 401 });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(first.decision, 'deny');
        assert.equal(first.inactive, true);
        assert.equal(first.status, 401);
        assert.equal(first.errorType, errorType);
        assert.equal(second.decision, 'deny');
        assert.equal(second.inactive, true);
        assert.equal(calls, 2);
      },
    );
  }
});

test('401 without an error_type uses the stable UNAUTHORIZED fallback', async () => {
  await withFetch(
    (async () => new Response('unauthorized', { status: 401 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, true);
      assert.equal(result.errorType, 'UNAUTHORIZED');
    },
  );
});

test('every 500-599 response fails closed (deny), every call, with no persistence of any kind', async () => {
  for (const status of [500, 502, 503, 504, 599]) {
    let calls = 0;
    const errorType = `ENGINE_${status}`;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: errorType }), { status });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(first.decision, 'deny');
        assert.equal(first.inactive, undefined);
        assert.equal(first.status, status);
        assert.equal(first.errorType, errorType);
        assert.equal(second.decision, 'deny');
        assert.equal(calls, 2);
      },
    );
  }
});

test('non-JSON 5xx uses the stable RTG_SERVER_ERROR fallback and still fails closed (deny)', async () => {
  await withFetch(
    (async () => new Response('bad gateway', { status: 502 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, undefined);
      assert.equal(result.status, 502);
      assert.equal(result.errorType, 'RTG_SERVER_ERROR');
    },
  );
});

test('403 without context.reason still uses the fixed organization security-policy message', async () => {
  await withFetch(
    (async () => new Response('{}', { status: 403 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(
        result.reason,
        "Blocked by your organization's security policy.",
      );
    },
  );
});

test('404 fails closed (deny), using the stable RTG_NOT_FOUND fallback when unset', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response('', { status: 404 });
    }) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, undefined);
      assert.equal(result.status, 404);
      assert.equal(result.errorType, 'RTG_NOT_FOUND');
      assert.equal(calls, 1);
    },
  );
});

test('400 denies without failing open', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
    }) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, undefined);
      assert.equal(calls, 1);
    },
  );
});

test('413 fails open without denying, every call, with no persistence of any kind', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error_type: 'PAYLOAD_TOO_LARGE' }), { status: 413 });
    }) as any,
    async () => {
      const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(first.decision, 'allow');
      assert.equal(first.inactive, true);
      assert.equal(first.status, 413);
      assert.equal(first.errorType, 'PAYLOAD_TOO_LARGE');
      assert.equal(second.decision, 'allow');
      assert.equal(calls, 2);
    },
  );
});

test('413 without an error_type uses the stable RTG_PAYLOAD_TOO_LARGE fallback', async () => {
  await withFetch(
    (async () => new Response('too large', { status: 413 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'allow');
      assert.equal(result.inactive, true);
      assert.equal(result.errorType, 'RTG_PAYLOAD_TOO_LARGE');
    },
  );
});

test('every 424 response fails closed (deny), every call, using the stable RTG_FAILED_DEPENDENCY fallback when unset', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response('', { status: 424 });
    }) as any,
    async () => {
      const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(first.decision, 'deny');
      assert.equal(first.inactive, undefined);
      assert.equal(first.status, 424);
      assert.equal(first.errorType, 'RTG_FAILED_DEPENDENCY');
      assert.equal(second.decision, 'deny');
      assert.equal(calls, 2);
    },
  );
});

test('network failure synthesizes 503 RTG_UNAVAILABLE and fails closed (deny)', async () => {
  await withFetch(
    (async () => {
      throw new Error('ECONNREFUSED');
    }) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, undefined);
      assert.equal(result.status, 503);
      assert.equal(result.errorType, 'RTG_UNAVAILABLE');
    },
  );
});

test('timeout synthesizes 504 RTG_TIMEOUT and fails closed (deny)', async () => {
  await withFetch(
    ((_url: any, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })) as any,
    async () => {
      const result = await evaluate({ ...baseCfg, timeoutMs: 10 }, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, undefined);
      assert.equal(result.status, 504);
      assert.equal(result.errorType, 'RTG_TIMEOUT');
    },
  );
});

test('request uses canonical body and raw X-API-Token header', async () => {
  let headers: Record<string, string> | undefined;
  let body: any;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01');
    },
  );
  assert.equal(headers?.['X-API-Token'], 'test-token');
  assert.equal(headers?.['X-API-Origin-App'], 'CODEX');
  assert.equal(headers?.['X-Reva-Verification-Codes'], 'CODE_USER_SCOPE');
  assert.equal(headers?.Authorization, undefined);
  assert.equal(body.transmission.promptKey, 'userQuery');
  assert.deepEqual(body.context.hops[0].action, { name: 'invokeAgent' });
  assert.deepEqual(body.session, baseRequest.session);
  assert.equal('messages' in body.session, false);
  assert.equal('entities' in body, false);
  assert.equal('hops' in body, false);
});


test('X-Reva-Thread-Id is sent when evaluate is given a threadId', async () => {
  let headers: Record<string, string> | undefined;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01', undefined, 'sess-thread-1');
    },
  );
  assert.equal(headers?.['X-Reva-Thread-Id'], 'sess-thread-1');
});

test('X-Reva-Thread-Id is omitted when no threadId is passed', async () => {
  let headers: Record<string, string> | undefined;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01');
    },
  );
  assert.equal(headers?.['X-Reva-Thread-Id'], undefined);
});

test('policyStoreId rides on the evaluation request only when configured', async () => {
  const seen: Record<string, any>[] = [];
  const capture = (async (_url: string, init: any) => {
    seen.push(init.headers);
    return new Response('{}', { status: 200 });
  }) as any;

  await withFetch(capture, async () => {
    await evaluate(baseCfg, baseRequest, '00-x-y-01');
  });
  assert.ok(!('policyStoreId' in seen[0]), 'must not be sent when unset');

  await withFetch(capture, async () => {
    await evaluate({ ...baseCfg, policyStoreId: 'store-123' }, baseRequest, '00-x-y-01');
  });
  assert.equal(seen[1].policyStoreId, 'store-123');
  assert.equal(seen[1]['X-API-Token'], 'test-token');
});

test('401 latches THIS session: the next call in it skips the RTG entirely', async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: 'USER_NOT_FOUND' }), { status: 401 });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(calls, 1);
        assert.equal(first.inactive, true);

        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        // Still one network call — the latch short-circuited this one.
        assert.equal(calls, 1);
        assert.equal(second.decision, 'allow');
        assert.equal(second.inactive, true);
        assert.equal(second.status, 401);
        assert.equal(second.errorType, 'USER_NOT_FOUND');
        assert.match(second.reason!, /unavailable for this session/);
      },
    );
  });
});

test('a NEW session calls the RTG again — restarting is the recovery', async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response('', { status: 401 });
      }) as any,
      async () => {
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(calls, 1);
        // Same call again in the latched session: skipped.
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(calls, 1);

        // A different session is untouched and reaches the RTG. Under the old
        // agent-keyed 4-hour window this was silenced too, so a user whose
        // licence had since been fixed kept failing open for hours.
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-2');
        assert.equal(calls, 2);
      },
    );
  });
});

test('with no session id there is no latch, so every call reaches the RTG', async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response('', { status: 401 });
      }) as any,
      async () => {
        // Nothing to key a latch by. A 401 still fails open per call, exactly
        // as it did before any latch existed — it just is not remembered.
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir);
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir);
        assert.equal(calls, 2);
      },
    );
  });
});

test('the latch is keyed by SESSION, not by agent — agentId has no effect on it', async () => {
  await withTempDir(async (dir) => {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response('', { status: 401 });
      }) as any,
      async () => {
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(calls, 1);

        // A DIFFERENT agent in the SAME session is still latched: the key is
        // the session id, and agentId is not part of it any more. Under the
        // old scheme this was the reverse — keyed by agent, so it spanned
        // every session on the machine.
        const otherAgent = { ...baseCfg, agentId: 'agent-b' };
        await evaluate(otherAgent, baseRequest, '00-x-y-01', dir, 'sess-1');
        assert.equal(calls, 1);

        // …and the same agent in a different session is not.
        await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-2');
        assert.equal(calls, 2);
      },
    );
  });
});

test('with a pluginDataDir, statuses that now fail closed never open the circuit breaker', async () => {
  for (const status of [404, 424, 500, 502, 503, 504]) {
    await withTempDir(async (dir) => {
      let calls = 0;
      await withFetch(
        (async () => {
          calls += 1;
          return new Response('', { status });
        }) as any,
        async () => {
          await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
          await evaluate(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
          assert.equal(calls, 2, `status ${status} should not have tripped the breaker`);
        },
      );
    });
  }
});
