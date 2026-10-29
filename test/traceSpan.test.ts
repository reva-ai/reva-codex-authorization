import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// End-to-end over the REAL compiled PreToolUse and PostToolUse entrypoints:
// the span is computed independently in two separate processes, so only a
// real pair of runs can show that each resource's pre and post records meet
// on one span — and that a multi-resource call no longer puts every resource
// on the same span.

interface Recorded {
  resourceId: string;
  traceparent: string;
}

async function runHook(entrypoint: string, input: Record<string, unknown>, cwd: string): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        if (body?.action) {
          recorded.push({ resourceId: body.resource.id, traceparent: String(req.headers.traceparent ?? '') });
        }
      } catch {
        // not an evaluation request
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-data-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, `../src/${entrypoint}`)], {
      cwd,
      env: {
        ...process.env,
        REVA_MODEL_CONTEXT: '',
        REVA_POLICY_STORE_ID: '',
        REVA_DEBUG: '',
        REVA_HOST: `127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'test-agent',
        PLUGIN_DATA: dataDir,
        REVA_CODEX_AUTH_PATH: path.join(dataDir, 'no-auth.json'),
        CODEX_HOME: dataDir,
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: '',
        CODEX_MANAGED_PACKAGE_ROOT: '',
        CODEX_MANAGED_BY_NPM: '',
        TERM_PROGRAM: '',
        VSCODE_CODE_CACHE_PATH: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, `${entrypoint} exited ${code}: ${stderr}`);
    return recorded;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

function makeRepo(t: any): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-span-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'demo-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'alpha-span.txt'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'beta-span.txt'), '', 'utf8');
  return repo;
}

function parts(traceparent: string): { traceId: string; spanId: string } {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparent);
  assert.ok(match, `not a W3C traceparent: "${traceparent}"`);
  return { traceId: match[1], spanId: match[2] };
}

test('a multi-resource tool call gets one span per resource, and each post meets its pre', async (t) => {
  const repo = makeRepo(t);
  const base = {
    session_id: 'sess-span',
    turn_id: 'turn-span',
    cwd: repo,
    model: 'gpt-5.6-terra',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'cat alpha-span.txt beta-span.txt' },
    tool_use_id: 'call-span',
    transcript_path: null,
  };

  const pre = await runHook('authorize.js', { ...base, hook_event_name: 'PreToolUse' }, repo);
  const post = await runHook(
    'authorizePost.js',
    { ...base, hook_event_name: 'PostToolUse', tool_response: { output: '', exit_code: 0 } },
    repo,
  );

  const alpha = 'demo-repo/alpha-span.txt';
  const beta = 'demo-repo/beta-span.txt';
  const spanOf = (records: Recorded[], id: string): string => {
    const hit = records.filter((r) => r.resourceId === id);
    assert.equal(hit.length, 1, `expected one request for ${id}, saw ${JSON.stringify(records)}`);
    return parts(hit[0].traceparent).spanId;
  };

  // The two resources get different spans.
  assert.notEqual(spanOf(pre, alpha), spanOf(pre, beta));
  // Each resource's post span equals its pre span.
  assert.equal(spanOf(post, alpha), spanOf(pre, alpha));
  assert.equal(spanOf(post, beta), spanOf(pre, beta));
  // Every request shares one trace id — the turn.
  const traceIds = new Set([...pre, ...post].map((r) => parts(r.traceparent).traceId));
  assert.equal(traceIds.size, 1);
});
