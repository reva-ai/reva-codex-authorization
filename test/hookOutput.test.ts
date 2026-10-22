import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// End-to-end over the REAL compiled entrypoints, because the entire decision
// contract on Codex lives in the exit code and the stream a message lands on
// — none of which a unit test of a pure function can observe.
//
// The contract being asserted here (from codex-rs/hooks, rust-v0.151.0):
//   allow            -> exit 0, EMPTY stdout
//   deny             -> exit 2, non-empty stderr (the reason)
//   inactive RTG     -> exit 0, empty stdout (401 / 413 only)
//   outage RTG       -> exit 2 (5xx / 424 / timeout — fail closed)
//   conditional_allow-> exit 0, stdout carries ONLY additionalContext
//   internal error   -> exit 2 (fail closed)
// and, on every path, that no rejected field is ever emitted.

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  requests: any[];
}

type Responder = (body: any) => { status: number; payload?: any };

const ALLOW: Responder = () => ({ status: 200, payload: { decision: true } });
const DENY: Responder = () => ({ status: 403, payload: { context: { reason: 'denied by mock policy' } } });
const CONDITIONAL: Responder = () => ({
  status: 200,
  payload: {
    decision: true,
    guardrails: { status: 'complete', outcome: 'conditional_allow', reason: 'needs a human' },
  },
});

function makeRepo(t: any): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'demo-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'b.txt'), '', 'utf8');
  return repo;
}

async function runHook(
  entrypoint: string,
  input: Record<string, unknown>,
  responder: Responder,
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<HookRun> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (body?.action) requests.push(body);
      const { status, payload } = responder(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-data-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, `../src/${entrypoint}`)], {
      cwd: options.cwd,
      env: {
        ...process.env,
        // Neutralize every OPT-IN knob explicitly. process.env is inherited
        // for PATH and friends, which means a developer machine that has
        // `setx REVA_MODEL_CONTEXT 1` set would otherwise leak that into a
        // test asserting the DEFAULT shape — and the test would fail (or
        // worse, pass) for reasons unrelated to the code. Any test that wants
        // a knob on sets it through options.env below.
        REVA_MODEL_CONTEXT: '',
        REVA_POLICY_STORE_ID: '',
        REVA_DEBUG: '',
        REVA_HOST: `127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'test-agent',
        PLUGIN_DATA: dataDir,
        // Point identity at a path that does not exist so the real
        // ~/.codex/auth.json is never read during tests.
        REVA_CODEX_AUTH_PATH: path.join(dataDir, 'no-auth.json'),
        // Isolate config.toml the same way — otherwise a developer machine
        // with [reva] auth_token set would silently satisfy loadConfig even
        // when the test clears REVA_AUTH_TOKEN.
        CODEX_HOME: dataDir,
        // Same reasoning: the surface markers must not leak in from the
        // machine running the suite.
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: '',
        CODEX_MANAGED_PACKAGE_ROOT: '',
        CODEX_MANAGED_BY_NPM: '',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr, requests };
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

// REVA_HOST is http-only for localhost/127.0.0.1, matching config.ts.
function preToolInput(repo: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess-1',
    turn_id: 'turn-1',
    cwd: repo,
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.6-terra',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'Get-Content a.txt' },
    tool_use_id: 'call-1',
    transcript_path: null,
    ...overrides,
  };
}

// Every field Codex's parser rejects. Emitting any one of them sets
// invalid_reason and DISCARDS THE WHOLE OUTPUT — including a deny sent
// alongside it — so this guard runs on every stdout the plugin produces.
const REJECTED_FIELDS = [
  'permissionDecision',
  'permissionDecisionReason',
  'decision',
  'continue',
  'stopReason',
  'suppressOutput',
  'updatedInput',
  'updatedMCPToolOutput',
];

function assertNoRejectedFields(stdout: string): void {
  if (!stdout.trim()) return;
  const parsed = JSON.parse(stdout);
  const seen = new Set<string>();
  const walk = (value: any): void => {
    if (value == null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      seen.add(k);
      walk(v);
    }
  };
  walk(parsed);
  for (const field of REJECTED_FIELDS) {
    assert.ok(!seen.has(field), `output must never contain "${field}" — the parser discards the whole payload`);
  }
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

test('allow is exit 0 with COMPLETELY empty stdout — never permissionDecision:"allow"', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', preToolInput(repo), ALLOW);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 1);
});

test('deny is exit 2 with the reason on stderr and nothing on stdout', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', preToolInput(repo), DENY);
  assert.equal(run.code, 2);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /Blocked by your organization's security policy/);
  // Non-empty stderr is load-bearing: exit 2 with empty stderr downgrades to
  // a non-blocking failure and the tool call proceeds.
  assert.ok(run.stderr.trim().length > 0);
});

test('conditional_allow becomes a non-blocking additionalContext note', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', preToolInput(repo), CONDITIONAL);
  assert.equal(run.code, 0);
  const output = JSON.parse(run.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /needs a human/);
  assert.match(output.hookSpecificOutput.additionalContext, /advisory only/);
  assertNoRejectedFields(run.stdout);
});

test('an inactive RTG (401 / 413) passes through silently rather than blocking', async (t) => {
  const repo = makeRepo(t);
  for (const status of [401, 413]) {
    const run = await runHook('authorize.js', preToolInput(repo), () => ({ status, payload: { error_type: 'X' } }));
    assert.equal(run.code, 0, `HTTP ${status} must not block: ${run.stderr}`);
    assert.equal(run.stdout, '', `HTTP ${status} must emit no decision`);
  }
});

test('an RTG outage (5xx / 424) fails closed and blocks', async (t) => {
  const repo = makeRepo(t);
  for (const status of [424, 500, 503]) {
    const run = await runHook('authorize.js', preToolInput(repo), () => ({ status, payload: { error_type: 'X' } }));
    assert.equal(run.code, 2, `HTTP ${status} must block: ${run.stderr}`);
    assert.match(run.stderr, /blocked while Reva is unavailable/);
  }
});

test('a non-401 4xx is a real denial, not an outage', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', preToolInput(repo), () => ({ status: 400, payload: { message: 'bad input' } }));
  assert.equal(run.code, 2);
  assert.match(run.stderr, /bad input/);
});

test('malformed stdin fails CLOSED with exit 2, not a non-blocking exit 1', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', {} as any, ALLOW, { env: {} });
  // Any exit code other than 0 or 2 is reported as a hook failure and the
  // tool call PROCEEDS — which is why this must be exactly 2.
  assert.equal(run.code, 2);
  assert.match(run.stderr, /internal error/);
});

test('a missing auth token fails closed rather than silently disabling enforcement', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook('authorize.js', preToolInput(repo), ALLOW, { env: { REVA_AUTH_TOKEN: '' } });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /missing: REVA_AUTH_TOKEN/);
});

test('an over-cap command is denied without consulting the RTG at all', async (t) => {
  const repo = makeRepo(t);
  const many: string[] = [];
  for (let i = 0; i < 12; i++) {
    const name = `f${i}.txt`;
    fs.writeFileSync(path.join(repo, name), '', 'utf8');
    many.push(name);
  }
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_input: { command: `Get-Content ${many.join(',')}` } }),
    ALLOW,
  );
  assert.equal(run.code, 2);
  assert.match(run.stderr, /above the 10-resource limit/);
  assert.match(run.stderr, /Split it into separate commands/);
  assert.equal(run.requests.length, 0);
});

test('an unparseable apply_patch is denied — a mutation with an unknown target must not pass', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_name: 'apply_patch', tool_input: { command: 'garbage' } }),
    ALLOW,
  );
  assert.equal(run.code, 2);
  assert.match(run.stderr, /could not determine which resources/);
  assert.equal(run.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Multi-resource composition, through the real process
// ---------------------------------------------------------------------------

test('one chained command produces one RTG request per resource', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_input: { command: 'Get-Content a.txt; Get-Content b.txt' } }),
    ALLOW,
  );
  assert.equal(run.code, 0);
  assert.equal(run.requests.length, 2);
  assert.deepEqual(
    run.requests.map((r) => r.resource.id).sort(),
    ['demo-repo/a.txt', 'demo-repo/b.txt'],
  );
  // One action, N views of it: everything but the resource is identical.
  assert.equal(new Set(run.requests.map((r) => r.action.name)).size, 1);
  assert.equal(new Set(run.requests.map((r) => JSON.stringify(r.session))).size, 1);
});

test('denying ONE resource of several denies the whole call and names it', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_input: { command: 'Get-Content a.txt; Get-Content b.txt' } }),
    (body) =>
      body?.resource?.id === 'demo-repo/b.txt'
        ? { status: 403, payload: { context: { reason: 'b is protected' } } }
        : { status: 200, payload: { decision: true } },
  );
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Blocked by your organization's security policy/);
  assert.match(run.stderr, /demo-repo\/b\.txt/);
  assert.match(run.stderr, /2 resources evaluated/);
});

test('an apply_patch touching three files evaluates all three as File mutations', async (t) => {
  const repo = makeRepo(t);
  const patch = [
    '*** Begin Patch',
    '*** Add File: c.txt',
    '+new',
    '*** Update File: a.txt',
    '@@',
    '+changed',
    '*** Delete File: b.txt',
    '*** End Patch',
  ].join('\n');
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_name: 'apply_patch', tool_input: { command: patch } }),
    ALLOW,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.requests.length, 3);
  assert.deepEqual(
    run.requests.map((r) => [r.action.name, r.resource.id]).sort(),
    [
      ['edit', 'demo-repo/a.txt'],
      ['write', 'demo-repo/b.txt'],
      ['write', 'demo-repo/c.txt'],
    ].sort(),
  );
  for (const r of run.requests) assert.equal(r.resource.type, 'File');
});

// ---------------------------------------------------------------------------
// The other three entrypoints
// ---------------------------------------------------------------------------

test('UserPromptSubmit: allow is silent, deny is exit 2', async (t) => {
  const repo = makeRepo(t);
  const input = {
    session_id: 'sess-1',
    turn_id: 'turn-1',
    cwd: repo,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6-terra',
    permission_mode: 'default',
    prompt: 'add a login form',
    transcript_path: null,
  };
  const allowed = await runHook('authorizePrompt.js', input, ALLOW);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
  assert.equal(allowed.requests[0].action.name, 'invokeAgent');
  assert.equal(allowed.requests[0].transmission.userQuery, 'add a login form');

  const denied = await runHook('authorizePrompt.js', input, DENY);
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /Blocked by your organization's security policy/);

  const conditional = await runHook('authorizePrompt.js', input, CONDITIONAL);
  assert.equal(conditional.code, 0);
  assert.equal(JSON.parse(conditional.stdout).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assertNoRejectedFields(conditional.stdout);
});

test('PostToolUse: deny is exit 2, and the tool response rides in transmission', async (t) => {
  const repo = makeRepo(t);
  const input = preToolInput(repo, {
    hook_event_name: 'PostToolUse',
    tool_response: { ok: true, output: 'contents' },
  });
  const allowed = await runHook('authorizePost.js', input, ALLOW);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
  assert.equal(allowed.requests[0].transmission.role, 'tool');
  assert.equal(allowed.requests[0].transmission.contentType, 'text/plain');
  assert.equal(allowed.requests[0].transmission.response, '{"ok":true,"output":"contents"}');

  const denied = await runHook('authorizePost.js', input, DENY);
  assert.equal(denied.code, 2);

  const conditional = await runHook('authorizePost.js', input, CONDITIONAL);
  assert.equal(conditional.code, 0);
  assert.equal(JSON.parse(conditional.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
  assertNoRejectedFields(conditional.stdout);
});

test('PostToolUse passes through when there is nothing evaluable — the tool already ran', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorizePost.js',
    preToolInput(repo, {
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: 'garbage' },
      tool_response: { ok: false },
    }),
    ALLOW,
  );
  // Denying here would replace a real result with an error for no benefit:
  // the side effect has already happened, and PreToolUse is the gate.
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 0);
});

test('PreToolUse: an MCP server with no known url is never evaluated — zero RTG calls, true pass-through', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_name: 'mcp__claude-browser__computer', tool_input: { action: 'screenshot' } }),
    ALLOW,
  );
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 0);
});

test('PreToolUse: an MCP server WITH a url in config.toml is still evaluated normally', async (t) => {
  const repo = makeRepo(t);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-hook-codex-home-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(codexHome, 'config.toml'),
    ['[mcp_servers.github]', 'url = "https://api.githubcopilot.com/mcp/"'].join('\n'),
    'utf8',
  );
  const run = await runHook(
    'authorize.js',
    preToolInput(repo, { tool_name: 'mcp__github__search_repositories', tool_input: { query: 'anthropic' } }),
    ALLOW,
    { env: { CODEX_HOME: codexHome } },
  );
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].resource.id, 'github/search_repositories');
});

test('SessionStart never blocks — not on a 5xx, not without a token, not on bad stdin', async (t) => {
  const repo = makeRepo(t);
  const input = {
    session_id: 'sess-1',
    cwd: repo,
    hook_event_name: 'SessionStart',
    model: 'gpt-5.6-terra',
    permission_mode: 'default',
    source: 'startup',
    transcript_path: null,
  };
  for (const [label, run] of [
    ['5xx', await runHook('sessionStart.js', input, () => ({ status: 500 }))],
    ['no token', await runHook('sessionStart.js', input, ALLOW, { env: { REVA_AUTH_TOKEN: '' } })],
    ['bad stdin', await runHook('sessionStart.js', {} as any, ALLOW)],
    ['deny', await runHook('sessionStart.js', input, DENY)],
  ] as const) {
    assert.equal(run.code, 0, `SessionStart must always exit 0 (${label}): ${run.stderr}`);
    assert.equal(run.stdout, '', `SessionStart must emit nothing (${label})`);
  }
});

test('end to end: the flag controls context.model in the real outgoing request', async (t) => {
  const repo = makeRepo(t);
  const input = preToolInput(repo, { model: 'gpt-5.6-terra' });

  const off = await runHook('authorize.js', input, ALLOW);
  assert.equal(off.code, 0, off.stderr);
  assert.ok(!('model' in off.requests[0].context), 'model must not be sent by default');
  assert.ok('os' in off.requests[0].context, 'os is sent on every action');
  assert.ok('machineId' in off.requests[0].context, 'machineId is sent on every action');

  const on = await runHook('authorize.js', input, ALLOW, { env: { REVA_MODEL_CONTEXT: '1' } });
  assert.equal(on.code, 0, on.stderr);
  assert.equal(on.requests[0].context.model, 'gpt-5.6-terra');
  assert.ok('os' in on.requests[0].context);
  assert.equal(on.requests[0].context.agentType, 'Codex');
});

test('end to end: UserPromptSubmit sends the same model on invokeAgent', async (t) => {
  const repo = makeRepo(t);
  const run = await runHook(
    'authorizePrompt.js',
    {
      session_id: 'sess-1',
      turn_id: 'turn-1',
      cwd: repo,
      hook_event_name: 'UserPromptSubmit',
      model: 'gpt-5.6-terra',
      permission_mode: 'default',
      prompt: 'do the thing',
      transcript_path: null,
    },
    ALLOW,
    { env: { REVA_MODEL_CONTEXT: '1' } },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.requests[0].action.name, 'invokeAgent');
  assert.equal(run.requests[0].context.model, 'gpt-5.6-terra');
});
