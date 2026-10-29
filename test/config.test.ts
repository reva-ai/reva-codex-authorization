import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { assertTokenVisible, loadConfig, urlFromHost } from '../src/config';
import { parseRevaToml, readCodexRevaConfig } from '../src/codexRevaConfig';

// Isolate from the developer's real ~/.codex/config.toml.
const NO_CONFIG = path.join(os.tmpdir(), 'reva-codex-no-config-does-not-exist.toml');

function tempConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-codex-config-'));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

const base = { REVA_AUTH_TOKEN: 'test-token', REVA_AGENT_ID: 'fixed-agent' } as NodeJS.ProcessEnv;

test('defaults to api.reva.ai over https with the fixed paths', () => {
  const cfg = loadConfig({ ...base }, NO_CONFIG);
  assert.equal(cfg.rtgUrl, 'https://api.reva.ai/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'https://api.reva.ai/ingestion/v2');
});

test('localhost uses http so the mock RTG works without TLS', () => {
  const cfg = loadConfig({ ...base, REVA_HOST: 'localhost:8787' }, NO_CONFIG);
  assert.equal(cfg.rtgUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'http://localhost:8787/ingestion/v2');
});

test('a host given with a scheme or trailing slash is normalized', () => {
  assert.equal(urlFromHost('https://pdp.example.com/', '/x'), 'https://pdp.example.com/x');
  assert.equal(urlFromHost('http://127.0.0.1:9000', '/x'), 'http://127.0.0.1:9000/x');
});

test('timeouts default, and are overridable independently', () => {
  const defaults = loadConfig({ ...base }, NO_CONFIG);
  assert.equal(defaults.timeoutMs, 25000);
  assert.equal(defaults.ingestionTimeoutMs, 5000);
  const overridden = loadConfig(
    { ...base, REVA_PDP_TIMEOUT_MS: '1000', REVA_INGESTION_TIMEOUT_MS: '250' },
    NO_CONFIG,
  );
  assert.equal(overridden.timeoutMs, 1000);
  assert.equal(overridden.ingestionTimeoutMs, 250);
});

test('REVA_AGENT_ID overrides the detected hardware id', () => {
  assert.equal(loadConfig({ ...base }, NO_CONFIG).agentId, 'fixed-agent');
});

test('a missing token fails immediately, with a message naming the real cause', () => {
  assert.throws(() => loadConfig({}, NO_CONFIG), /missing: REVA_AUTH_TOKEN/);
  assert.throws(() => loadConfig({}, NO_CONFIG), /config\.toml/);
  assert.throws(() => loadConfig({}, NO_CONFIG), /\[reva\]/);
  assert.throws(() => loadConfig({}, NO_CONFIG), /does NOT help here/);
});

test('a blank or whitespace-only token counts as missing', () => {
  assert.throws(() => assertTokenVisible({ REVA_AUTH_TOKEN: '' }), /missing: REVA_AUTH_TOKEN/);
  assert.throws(() => assertTokenVisible({ REVA_AUTH_TOKEN: '   ' }), /missing: REVA_AUTH_TOKEN/);
});

test('assertTokenVisible returns the token when it is present', () => {
  assert.equal(assertTokenVisible({ REVA_AUTH_TOKEN: 'abc' }), 'abc');
});

test('there is no CLAUDE_PLUGIN_OPTION fallback — Codex has no userConfig dialog', () => {
  assert.throws(
    () => loadConfig({ CLAUDE_PLUGIN_OPTION_AUTH_TOKEN: 'from-dialog' }, NO_CONFIG),
    /missing: REVA_AUTH_TOKEN/,
  );
});

test('policyStoreId is omitted unless explicitly configured', () => {
  assert.equal(loadConfig({ ...base }, NO_CONFIG).policyStoreId, undefined);
  assert.equal(loadConfig({ ...base, REVA_POLICY_STORE_ID: '   ' }, NO_CONFIG).policyStoreId, undefined);
  assert.equal(
    loadConfig({ ...base, REVA_POLICY_STORE_ID: ' cb73c0be-9fb2-4312-8100-ef668e3a9c72 ' }, NO_CONFIG)
      .policyStoreId,
    'cb73c0be-9fb2-4312-8100-ef668e3a9c72',
  );
});

test('modelContext is off unless explicitly enabled', () => {
  assert.equal(loadConfig({ ...base }, NO_CONFIG).modelContext, false);
  assert.equal(loadConfig({ ...base, REVA_MODEL_CONTEXT: '0' }, NO_CONFIG).modelContext, false);
  assert.equal(loadConfig({ ...base, REVA_MODEL_CONTEXT: '1' }, NO_CONFIG).modelContext, true);
  assert.equal(loadConfig({ ...base, REVA_MODEL_CONTEXT: 'true' }, NO_CONFIG).modelContext, true);
});

test('the Agent id has NO fallback — an unresolvable account fails loudly', () => {
  const noAuth = { REVA_AUTH_TOKEN: 'test-token', REVA_CODEX_AUTH_PATH: '/definitely/not/here/auth.json' };
  assert.throws(() => loadConfig(noAuth, NO_CONFIG), /cannot resolve a stable account id/);
  assert.throws(() => loadConfig(noAuth, NO_CONFIG), /REVA_AGENT_ID/);
});

test('REVA_AGENT_ID is the documented escape hatch when no account exists', () => {
  const cfg = loadConfig(
    {
      REVA_AUTH_TOKEN: 'test-token',
      REVA_CODEX_AUTH_PATH: '/definitely/not/here/auth.json',
      REVA_AGENT_ID: 'explicit-account',
    },
    NO_CONFIG,
  );
  assert.equal(cfg.agentId, 'explicit-account');
});

test('reads auth_token from [reva] in config.toml when env is unset', () => {
  const file = tempConfig(`
[reva]
auth_token = "from-toml"
agent_id = "agent-toml"
host = "localhost:9999"
`);
  const cfg = loadConfig({}, file);
  assert.equal(cfg.authorization, 'from-toml');
  assert.equal(cfg.agentId, 'agent-toml');
  // Host from config.toml when REVA_HOST env is unset
  assert.equal(cfg.rtgUrl, 'http://localhost:9999/pdp/v2/ai/evaluation');
});

test('prefers config.toml over env for token/agentId; REVA_HOST env wins over file host', () => {
  const file = tempConfig(`
[reva]
auth_token = "toml-tok"
agent_id = "agent-toml"
host = "localhost:9999"
`);
  const cfg = loadConfig(
    {
      REVA_AUTH_TOKEN: 'env-tok',
      REVA_AGENT_ID: 'agent-e',
      REVA_HOST: 'localhost:8787',
    },
    file,
  );
  assert.equal(cfg.authorization, 'toml-tok');
  assert.equal(cfg.agentId, 'agent-toml');
  assert.equal(cfg.rtgUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
});

test('reads REVA_AUTH_TOKEN from [reva.env]', () => {
  const file = tempConfig(`
[reva.env]
REVA_AUTH_TOKEN = "from-env-block"
REVA_AGENT_ID = "agent-env"
REVA_DEBUG = "1"
`);
  const parsed = readCodexRevaConfig(file);
  assert.equal(parsed.authToken, 'from-env-block');
  assert.equal(parsed.agentId, 'agent-env');
  assert.equal(parsed.debug, true);
  const cfg = loadConfig({}, file);
  assert.equal(cfg.authorization, 'from-env-block');
});

test('prefers [reva.env] over [reva] auth_token', () => {
  const parsed = parseRevaToml(`
[reva]
auth_token = "flat"
[reva.env]
REVA_AUTH_TOKEN = "env-block"
`);
  assert.equal(parsed.authToken, 'env-block');
});

test('reads auth_token from the top of the file, before any header', () => {
  const parsed = parseRevaToml(`
auth_token = "top"
model = "gpt-5"
[tui]
screen_reader_detection_done = true
`);
  assert.equal(parsed.authToken, 'top');
});

test('reads auth_token next to enabled = true in the plugin table', () => {
  const parsed = parseRevaToml(`
[plugins."reva-security@reva-plugins"]
enabled = true
auth_token = "plugin"
`);
  assert.equal(parsed.authToken, 'plugin');
});

test('reads auth_token inside the marketplace table, quoted or bare', () => {
  assert.equal(
    parseRevaToml(`
[marketplaces.reva-plugins]
source_type = "git"
source = "https://github.com/reva-ai/reva-codex-authorization.git"
auth_token = "market"
`).authToken,
    'market',
  );
  assert.equal(parseRevaToml(`[marketplaces."reva-plugins"]\nauth_token = "market-q"`).authToken, 'market-q');
});

test('ignores auth_token under any other table, including at the end of the file', () => {
  const parsed = parseRevaToml(`
[plugins."reva-security@reva-plugins"]
enabled = true

[mcp_servers.github]
url = "https://example.com/mcp"
auth_token = "someone-elses"
`);
  assert.equal(parsed.authToken, undefined);
});

test('ignores auth_token under a different plugin or marketplace', () => {
  const parsed = parseRevaToml(`
[plugins."browser@openai-bundled"]
enabled = true
auth_token = "not-ours"
[marketplaces.openai-bundled]
auth_token = "not-ours-either"
`);
  assert.equal(parsed.authToken, undefined);
});

test('only auth_token is read from the fallback placements', () => {
  const parsed = parseRevaToml(`
host = "top.example"
[plugins."reva-security@reva-plugins"]
agent_id = "plugin-agent"
debug = true
`);
  assert.deepEqual(parsed, { authToken: undefined, host: undefined, agentId: undefined, debug: undefined });
});

test('token precedence: [reva.env] > [reva] > plugin table > marketplace table > top of file', () => {
  const all = {
    top: 'auth_token = "top"',
    market: '[marketplaces.reva-plugins]\nauth_token = "market"',
    plugin: '[plugins."reva-security@reva-plugins"]\nauth_token = "plugin"',
    reva: '[reva]\nauth_token = "reva"',
    env: '[reva.env]\nREVA_AUTH_TOKEN = "env-block"',
  };
  const build = (...parts: string[]) => parseRevaToml(parts.join('\n')).authToken;
  assert.equal(build(all.top, all.market, all.plugin, all.reva, all.env), 'env-block');
  assert.equal(build(all.top, all.market, all.plugin, all.reva), 'reva');
  assert.equal(build(all.top, all.market, all.plugin), 'plugin');
  assert.equal(build(all.top, all.market), 'market');
  assert.equal(build(all.top), 'top');
});

test('a fallback-placed token in config.toml wins over the REVA_AUTH_TOKEN env var', () => {
  const file = tempConfig(`
auth_token = "from-top"
[plugins."reva-security@reva-plugins"]
enabled = true
`);
  const cfg = loadConfig({ REVA_AUTH_TOKEN: 'env-tok', REVA_AGENT_ID: 'agent-t' }, file);
  assert.equal(cfg.authorization, 'from-top');
});

test('falls back to env when config.toml has no token', () => {
  const file = tempConfig(`
[projects."/tmp"]
trust_level = "trusted"
`);
  const cfg = loadConfig({ REVA_AUTH_TOKEN: 'env-tok', REVA_AGENT_ID: 'agent-e' }, file);
  assert.equal(cfg.authorization, 'env-tok');
});
