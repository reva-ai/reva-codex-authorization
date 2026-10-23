import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CLI_ENTRYPOINT,
  readCodexAccountId,
  UNKNOWN_ENTRYPOINT,
  readCodexAccountEmail,
  resolveAgentContext,
  resolveSessionEntrypoint,
} from '../src/identity';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;
}

function writeAuthJsonAt(contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-auth-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

function writeAuthJson(t: any, contents: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return file;
}

test('reads the top-level email claim out of tokens.id_token', (t) => {
  const file = writeAuthJson(t, { tokens: { id_token: jwt({ email: 'dev@example.com' }) } });
  assert.equal(readCodexAccountEmail(file), 'dev@example.com');
});

test('falls back to the OpenAI profile claim, matching Codex resolution order', (t) => {
  const file = writeAuthJson(t, {
    tokens: { id_token: jwt({ 'https://api.openai.com/profile': { email: 'profile@example.com' } }) },
  });
  assert.equal(readCodexAccountEmail(file), 'profile@example.com');
});

test('the top-level claim wins over the profile claim', (t) => {
  const file = writeAuthJson(t, {
    tokens: {
      id_token: jwt({ email: 'top@example.com', 'https://api.openai.com/profile': { email: 'profile@example.com' } }),
    },
  });
  assert.equal(readCodexAccountEmail(file), 'top@example.com');
});

test('API-key auth carries no email at all', (t) => {
  // A legitimate configuration, not an error: OPENAI_API_KEY auth has no
  // id_token, so the caller falls back to the OS username.
  const file = writeAuthJson(t, { OPENAI_API_KEY: 'sk-test', auth_mode: 'ApiKey' });
  assert.equal(readCodexAccountEmail(file), undefined);
});

test('a missing, malformed or signature-less file yields undefined rather than throwing', (t) => {
  assert.equal(readCodexAccountEmail(path.join(os.tmpdir(), 'nope-1a2b', 'auth.json')), undefined);
  assert.equal(readCodexAccountEmail(writeAuthJson(t, 'not json at all')), undefined);
  assert.equal(readCodexAccountEmail(writeAuthJson(t, { tokens: { id_token: 'not.a.jwt-payload' } })), undefined);
  assert.equal(readCodexAccountEmail(writeAuthJson(t, { tokens: { id_token: 'only-one-part' } })), undefined);
  assert.equal(readCodexAccountEmail(writeAuthJson(t, { tokens: {} })), undefined);
});

test('an id_token with claims but no email yields undefined', (t) => {
  const file = writeAuthJson(t, { tokens: { id_token: jwt({ sub: 'user-1', exp: 123 }) } });
  assert.equal(readCodexAccountEmail(file), undefined);
});

test('a base64url payload with - and _ decodes correctly', (t) => {
  // Ensures base64url (not plain base64) decoding — a payload large enough
  // to contain URL-safe characters must still parse.
  const email = 'a-very-long-address-with-padding@subdomain.example.com';
  const file = writeAuthJson(t, { tokens: { id_token: jwt({ email, note: '???>>>???' }) } });
  assert.equal(readCodexAccountEmail(file), email);
});

test('resolveAgentContext treats a missing agent_id as a top-level call', () => {
  assert.deepEqual(resolveAgentContext('machine-1', {}), {
    agentId: 'machine-1',
    isSubAgent: false,
    subAgentId: undefined,
    subAgentType: undefined,
  });
});

test('resolveAgentContext reports a subagent when agent_id is present', () => {
  assert.deepEqual(resolveAgentContext('machine-1', { agent_id: 'sub-9', agent_type: 'explorer' }), {
    agentId: 'machine-1',
    isSubAgent: true,
    subAgentId: 'sub-9',
    subAgentType: 'explorer',
  });
});

test('sessionEntryPoint reports the desktop originator verbatim', () => {
  // Measured on Codex 0.151.0: the desktop app sets this to "Codex Desktop".
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }), 'Codex Desktop');
});

test('the CLI is identified by its own launcher marker, not by absence', () => {
  // @openai/codex/bin/codex.js stamps CODEX_MANAGED_PACKAGE_ROOT for npm,
  // bun and pnpm alike before exec'ing the real binary.
  assert.equal(resolveSessionEntrypoint({ CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm/@openai/codex' }), CLI_ENTRYPOINT);
  // The per-manager markers work too, in case the shared one ever moves.
  assert.equal(resolveSessionEntrypoint({ CODEX_MANAGED_BY_NPM: '1' }), CLI_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ CODEX_MANAGED_BY_BUN: '1' }), CLI_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ CODEX_MANAGED_BY_PNPM: '1' }), CLI_ENTRYPOINT);
});

test('a named surface wins over the CLI marker', () => {
  // Should both ever appear, the surface that names itself is authoritative.
  assert.equal(
    resolveSessionEntrypoint({
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
      CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm/@openai/codex',
    }),
    'Codex Desktop',
  );
});

test('with NO marker at all it reports unknown, never a guessed surface', () => {
  // Real cases: a standalone-binary CLI install goes through no launcher, and
  // an MCP-driven session sets neither marker. An honest gap beats a
  // wrong-but-plausible label in a field policies match on.
  assert.equal(resolveSessionEntrypoint({}), UNKNOWN_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: '   ' }), UNKNOWN_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ CODEX_MANAGED_PACKAGE_ROOT: '  ' }), UNKNOWN_ENTRYPOINT);
});

test('an unrecognized originator passes through rather than being remapped', () => {
  // A future surface must report itself, not be bucketed into a known one.
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Web' }), 'Codex Web');
});

test('REVA_SESSION_ENTRYPOINT fills the gap when nothing is detectable', () => {
  // A Homebrew / direct-download Codex runs no launcher wrapper, so neither
  // the originator nor the package-manager marker exists.
  assert.equal(resolveSessionEntrypoint({ REVA_SESSION_ENTRYPOINT: 'codex-cli' }), 'codex-cli');
  assert.equal(resolveSessionEntrypoint({ REVA_SESSION_ENTRYPOINT: '  ' }), UNKNOWN_ENTRYPOINT);
});

test('a detected surface always beats the declared fallback', () => {
  // Otherwise a value exported for the CLI would mislabel a desktop session
  // that inherited the same environment.
  assert.equal(
    resolveSessionEntrypoint({
      REVA_SESSION_ENTRYPOINT: 'codex-cli',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    }),
    'Codex Desktop',
  );
  assert.equal(
    resolveSessionEntrypoint({
      REVA_SESSION_ENTRYPOINT: 'something-else',
      CODEX_MANAGED_PACKAGE_ROOT: '/usr/local/lib/node_modules/@openai/codex',
    }),
    CLI_ENTRYPOINT,
  );
});

// ---------------------------------------------------------------------------
// Account id — the Cedar Agent's identity: the ChatGPT account
// (`chatgpt_account_id`), stable across machines, and NOT the per-person
// user id sitting next to it.
// ---------------------------------------------------------------------------

test('the account id is chatgpt_account_id, not the per-person user id', () => {
  const file = writeAuthJsonAt({
    tokens: {
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-123',
          chatgpt_user_id: 'user-abc',
          user_id: 'user-abc',
        },
      }),
    },
  });
  assert.equal(readCodexAccountId(file), 'acct-123');
});

test('tokens.account_id is used when the id_token carries no chatgpt_account_id', () => {
  const noClaim = writeAuthJsonAt({
    tokens: { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-abc' } }), account_id: 'acct-123' },
  });
  assert.equal(readCodexAccountId(noClaim), 'acct-123');
  // And with no readable id_token at all.
  const noToken = writeAuthJsonAt({ tokens: { account_id: 'acct-123' } });
  assert.equal(readCodexAccountId(noToken), 'acct-123');
});

test('the claim wins over tokens.account_id when both are present', () => {
  const file = writeAuthJsonAt({
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-claim' } }),
      account_id: 'acct-field',
    },
  });
  assert.equal(readCodexAccountId(file), 'acct-claim');
});

test('the user id is never substituted — an install must not resolve to two kinds of id', () => {
  // With only per-person ids present there is no account id. Falling back to
  // them would split one Agent in two across runs.
  const file = writeAuthJsonAt({
    tokens: {
      id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_user_id: 'user-abc', user_id: 'user-abc' } }),
    },
  });
  assert.equal(readCodexAccountId(file), undefined);
});

test('the same login on two machines yields the SAME account id', () => {
  // This is the whole point of account-scoping over hardware-scoping: a
  // hardware id would produce two unrelated Agent entities for one account.
  const token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } });
  const machineA = writeAuthJsonAt({ tokens: { id_token: token } });
  const machineB = writeAuthJsonAt({ tokens: { id_token: token } });
  assert.equal(readCodexAccountId(machineA), readCodexAccountId(machineB));
});

test('API-key auth has no account id — no fallback is invented', () => {
  const file = writeAuthJsonAt({ OPENAI_API_KEY: 'sk-test', auth_mode: 'ApiKey' });
  assert.equal(readCodexAccountId(file), undefined);
  assert.equal(readCodexAccountId(path.join(os.tmpdir(), 'nope-9z', 'auth.json')), undefined);
});
