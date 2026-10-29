import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// hookOutput.test.ts covers the "SessionStart can never block" contract.
// This file covers what it actually DOES: the ingestion flow, driven through
// the real process against a stub of both ingestion endpoints.

interface Recorded {
  method: string;
  pathname: string;
  body: any;
}

async function runSessionStart(
  input: Record<string, unknown>,
  options: { codexConfig?: string; dataDir?: string; entityExists?: boolean; env?: Record<string, string> } = {},
): Promise<{ code: number | null; calls: Recorded[]; dataDir: string }> {
  const calls: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://localhost');
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      calls.push({ method: req.method || '', pathname: url.pathname, body });

      // The GET-then-branch existence check must answer BEFORE the blanket
      // 200 below, since it needs its own status. Default: entity absent, so
      // a cold start takes the create path.
      if (req.method === 'GET' && /^\/ingestion\/v2\/entity\//.test(url.pathname)) {
        const status = options.entityExists ? 200 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(options.entityExists ? JSON.stringify({ entityAttributes: [] }) : '{}');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.pathname === '/ingestion/v2/policy-store/entity-types') {
        res.end(
          JSON.stringify([
            { id: 'user-type', name: 'User', schemaName: 'CodingAgent' },
            { id: 'agent-type', name: 'Agent', schemaName: 'CodingAgent' },
            { id: 'mcp-type', name: 'MCPServer', schemaName: 'CodingAgent' },
          ]),
        );
        return;
      }
      res.end(JSON.stringify({ status: 'ok' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  try {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../src/sessionStart.js')], {
      env: {
        ...process.env,
        // See hookOutput.test.ts: opt-in knobs and surface markers must not
        // leak in from the developer's own environment.
        REVA_MODEL_CONTEXT: '',
        REVA_POLICY_STORE_ID: '',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? '',
        CODEX_MANAGED_PACKAGE_ROOT: process.env.CODEX_MANAGED_PACKAGE_ROOT ?? '',
        // Running the suite from VS Code (its terminal or an extension) sets
        // these; a test that wants an editor passes them in options.env.
        TERM_PROGRAM: '',
        VSCODE_CODE_CACHE_PATH: '',
        VSCODE_GIT_ASKPASS_MAIN: '',
        VSCODE_GIT_ASKPASS_NODE: '',
        ...options.env,
        REVA_HOST: `127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        REVA_AGENT_ID: 'machine-1',
        PLUGIN_DATA: dataDir,
        REVA_CODEX_AUTH_PATH: path.join(dataDir, 'no-auth.json'),
        ...(options.codexConfig ? { CODEX_HOME: path.dirname(options.codexConfig) } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    // MCP ingestion is a detached child of sessionStart — wait briefly for
    // its POSTs to land on the stub before we tear the server down, otherwise
    // the MCP coverage below races the parent's exit.
    if (options.codexConfig) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (calls.some((c) => c.method === 'POST' && c.body?.attributes?.some((a: any) => a.name === 'baseUrl'))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return { code, calls, dataDir };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const input = {
  session_id: 'sess-1',
  cwd: process.cwd(),
  hook_event_name: 'SessionStart',
  model: 'gpt-5.6-terra',
  permission_mode: 'default',
  source: 'startup',
  transcript_path: null,
};

test('a cold start resolves entity types, then ingests User and Agent', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const run = await runSessionStart(input, { dataDir });
  assert.equal(run.code, 0);

  const paths = run.calls.map((c) => `${c.method} ${c.pathname}`);
  assert.ok(paths.includes('GET /ingestion/v2/policy-store/entity-types'));

  const posts = run.calls.filter((c) => c.method === 'POST' && c.pathname === '/ingestion/v2/entity');
  const user = posts.find((c) => c.body?.attributes?.some((a: any) => a.name === 'active'));
  assert.ok(user, 'expected a User POST');
  // Never claims the human is vetted; carries both Sets in the create call.
  assert.deepEqual(
    user!.body.attributes.map((a: any) => a.name),
    ['active', 'registeredMachineIds', 'agents'],
  );

  // The Agent's entityId is the ACCOUNT id (REVA_AGENT_ID here), never the
  // machine id — that lives in User.registeredMachineIds instead.
  const agent = posts.find((c) => c.body?.entityId === 'machine-1');
  assert.ok(agent, 'expected an Agent POST keyed by the account id');
  assert.ok(agent!.body.attributes.some((a: any) => a.name === 'agentType'));

  // A brand-new entity needs no follow-up PATCH — everything rode in the POST.
  assert.equal(run.calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('SessionStart force-refreshes entity-type ids, and the existence check still runs every session', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await runSessionStart(input, { dataDir, entityExists: true });
  const second = await runSessionStart(input, { dataDir, entityExists: true });
  assert.equal(second.code, 0);

  // forceRefresh=true once per session — proactive refresh so a policy-store
  // migration cannot leave this session stuck on dead ids.
  assert.ok(
    second.calls.some((c) => c.pathname === '/ingestion/v2/policy-store/entity-types'),
    'entity-type catalog must be force-refreshed every SessionStart',
  );
  // The entity existence check must run EVERY session. This is what makes the
  // whole thing self-healing: delete the entity Reva-side and the next
  // session recreates it. A local "already ingested" flag broke exactly this.
  assert.ok(
    second.calls.some((c) => c.method === 'GET' && c.pathname.startsWith('/ingestion/v2/entity/')),
    'existence check must re-run every session',
  );
});

test('a remote MCP server in config.toml is ingested; a stdio one is not', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-codexhome-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(
    configPath,
    [
      '[mcp_servers.remote_docs]',
      'url = "https://docs.example.com/mcp"',
      '',
      '[mcp_servers.local_tool]',
      'command = "node"',
      'args = ["server.js"]',
    ].join('\n'),
    'utf8',
  );
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const run = await runSessionStart(input, { codexConfig: configPath, dataDir });
  assert.equal(run.code, 0);
  const mcpPosts = run.calls.filter(
    (c) => c.method === 'POST' && c.body?.attributes?.some((a: any) => a.name === 'baseUrl'),
  );
  assert.equal(mcpPosts.length, 1);
  assert.equal(mcpPosts[0].body.entityId, 'remote-docs');
  assert.deepEqual(
    mcpPosts[0].body.attributes.find((a: any) => a.name === 'baseUrl'),
    { name: 'baseUrl', value: 'https://docs.example.com/mcp' },
  );
});

test('the session is registered as active even before any ingestion happens', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await runSessionStart(input, { dataDir });
  const file = path.join(dataDir, 'active-sessions', 'machine-1.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.sessions['sess-1'], 'expected sess-1 to be registered');
  // The entrypoint is derived from CODEX_INTERNAL_ORIGINATOR_OVERRIDE, which
  // the desktop app sets to "Codex Desktop" and the CLI leaves unset. The
  // test harness sets neither, so it must report 'unknown' rather than
  // claiming a surface.
  assert.equal(state.sessions['sess-1'].entrypoint, 'unknown');
});

test('a desktop session records its surface, not a hardcoded CLI label', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const previous = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    else process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = previous;
  });

  await runSessionStart(input, { dataDir });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions', 'machine-1.json'), 'utf8'));
  assert.equal(state.sessions['sess-1'].entrypoint, 'Codex Desktop');
});

test('a CLI session records cli, not unknown', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const previous = process.env.CODEX_MANAGED_PACKAGE_ROOT;
  process.env.CODEX_MANAGED_PACKAGE_ROOT = 'C:/npm/node_modules/@openai/codex';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_MANAGED_PACKAGE_ROOT;
    else process.env.CODEX_MANAGED_PACKAGE_ROOT = previous;
  });

  await runSessionStart(input, { dataDir });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions', 'machine-1.json'), 'utf8'));
  assert.equal(state.sessions['sess-1'].entrypoint, 'cli');
});

test("a session from VS Code's terminal records ide-vscode", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await runSessionStart(input, {
    dataDir,
    env: {
      TERM_PROGRAM: 'vscode',
      VSCODE_GIT_ASKPASS_MAIN: 'C:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\vscode.git\\askpass-main.js',
    },
  });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions', 'machine-1.json'), 'utf8'));
  assert.equal(state.sessions['sess-1'].entrypoint, 'ide-vscode');
});

test('a session from the Codex extension chat panel records ide-vscode too', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-ss-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await runSessionStart(input, {
    dataDir,
    env: {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode',
      VSCODE_CODE_CACHE_PATH: 'C:\\Users\\dev\\AppData\\Roaming\\Code\\CachedData\\e646868227',
    },
  });
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions', 'machine-1.json'), 'utf8'));
  assert.equal(state.sessions['sess-1'].entrypoint, 'ide-vscode');
});
