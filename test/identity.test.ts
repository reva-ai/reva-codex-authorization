import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  CLI_ENTRYPOINT,
  IDE_ENTRYPOINT,
  IDE_ENTRYPOINT_PREFIX,
  readCodexAccountId,
  UNKNOWN_ENTRYPOINT,
  readCodexAccountEmail,
  resolveAgentContext,
  resolveEditor,
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

// Values observed live on VS Code 1.143.1 / Windows.
const VSCODE_TERMINAL = {
  TERM_PROGRAM: 'vscode',
  VSCODE_GIT_ASKPASS_MAIN:
    'c:\\Users\\dev\\AppData\\Roaming\\Code\\User\\globalStorage\\vscode.git\\askpass\\70789581cae28aa7\\askpass-main.js',
  VSCODE_GIT_ASKPASS_NODE: 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
};
const VSCODE_EXTENSION = {
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode',
  VSCODE_CODE_CACHE_PATH: 'C:\\Users\\dev\\AppData\\Roaming\\Code\\CachedData\\e646868227c3e3a9e3f24277c8c7220be42c0be7',
};

test('the policy-visible entrypoint strings are exactly cli, ide and ide-<editor>', () => {
  assert.equal(CLI_ENTRYPOINT, 'cli');
  assert.equal(IDE_ENTRYPOINT, 'ide');
  assert.equal(IDE_ENTRYPOINT_PREFIX, 'ide-');
});

test("VS Code's integrated terminal reports ide-vscode, even with the npm marker set", () => {
  // Typing `codex` in VS Code's terminal runs the npm launcher, so both
  // markers are present; the editor is the more specific one.
  assert.equal(
    resolveSessionEntrypoint({ ...VSCODE_TERMINAL, CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm/@openai/codex' }),
    'ide-vscode',
  );
  assert.equal(resolveSessionEntrypoint(VSCODE_TERMINAL), 'ide-vscode');
  assert.equal(resolveSessionEntrypoint({ ...VSCODE_TERMINAL, TERM_PROGRAM: ' VSCode ' }), 'ide-vscode');
});

test("the Codex extension's chat panel reports ide-vscode, the same as the terminal", () => {
  assert.equal(resolveSessionEntrypoint(VSCODE_EXTENSION), 'ide-vscode');
  // It also inherits whatever TERM_PROGRAM and launcher marker VS Code had.
  assert.equal(
    resolveSessionEntrypoint({ ...VSCODE_EXTENSION, TERM_PROGRAM: 'vscode', CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm' }),
    'ide-vscode',
  );
  // The Copilot-hosted variant of the extension is the same editor.
  assert.equal(
    resolveSessionEntrypoint({ ...VSCODE_EXTENSION, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode_copilot' }),
    'ide-vscode',
  );
});

test('the editor is named from its user-data folder on every OS', () => {
  const cache = (p: string) => resolveSessionEntrypoint({ VSCODE_CODE_CACHE_PATH: p });
  assert.equal(cache('C:\\Users\\dev\\AppData\\Roaming\\Cursor\\CachedData\\abc'), 'ide-cursor');
  assert.equal(cache('C:\\Users\\dev\\AppData\\Roaming\\Windsurf\\CachedData\\abc'), 'ide-windsurf');
  assert.equal(cache('C:\\Users\\dev\\AppData\\Roaming\\Code - Insiders\\CachedData\\abc'), 'ide-vscode-insiders');
  assert.equal(cache('/Users/dev/Library/Application Support/Code/CachedData/abc'), 'ide-vscode');
  assert.equal(cache('/Users/dev/Library/Application Support/Cursor/CachedData/abc'), 'ide-cursor');
  assert.equal(cache('/home/dev/.config/Code/CachedData/abc'), 'ide-vscode');
  // An editor this plugin has never heard of names itself.
  assert.equal(cache('C:\\Users\\dev\\AppData\\Roaming\\Some Editor\\CachedData\\abc'), 'ide-some-editor');

  const terminal = (main: string) => resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_MAIN: main });
  assert.equal(terminal('C:\\Users\\dev\\AppData\\Roaming\\Cursor\\User\\globalStorage\\vscode.git\\askpass-main.js'), 'ide-cursor');
  assert.equal(terminal('/home/dev/.config/Windsurf/User/globalStorage/vscode.git/askpass-main.js'), 'ide-windsurf');
});

test('the executable name is the last resort for naming the editor', () => {
  const exe = (node: string) => resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: node });
  assert.equal(exe('C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'), 'ide-vscode');
  assert.equal(exe('C:\\Users\\dev\\AppData\\Local\\Programs\\cursor\\Cursor.exe'), 'ide-cursor');
  assert.equal(
    exe('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'),
    'ide-vscode',
  );
  assert.equal(exe('/usr/share/code-insiders/code-insiders'), 'ide-vscode-insiders');
});

test('inside an editor that cannot be named it reports ide, never a guessed editor', () => {
  // e.g. Git terminal authentication turned off, so no askpass variables.
  assert.equal(resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode' }), IDE_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ TERM_PROGRAM: 'vscode', CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm' }), IDE_ENTRYPOINT);
  assert.equal(resolveSessionEntrypoint({ VSCODE_CODE_CACHE_PATH: 'C:\\no-marker-here' }), IDE_ENTRYPOINT);
  assert.equal(resolveEditor({ TERM_PROGRAM: 'vscode' }), undefined);
});

test('editor paths alone do not mean an editor; TERM_PROGRAM or the cache path must be present', () => {
  // A plain terminal never has these, but a stray askpass variable on its own
  // must not turn a CLI session into an IDE one.
  assert.equal(
    resolveSessionEntrypoint({
      VSCODE_GIT_ASKPASS_NODE: 'C:\\Programs\\Microsoft VS Code\\Code.exe',
      CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm',
    }),
    CLI_ENTRYPOINT,
  );
});

test('other terminals still report cli', () => {
  for (const term of ['Apple_Terminal', 'iTerm.app', 'tmux', 'WezTerm', '']) {
    assert.equal(
      resolveSessionEntrypoint({ TERM_PROGRAM: term, CODEX_MANAGED_PACKAGE_ROOT: 'C:/npm/@openai/codex' }),
      CLI_ENTRYPOINT,
    );
  }
});

test('originators other than the editor extension still pass through verbatim', () => {
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }), 'Codex Desktop');
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_jetbrains' }), 'codex_jetbrains');
  // With no editor markers, even the extension's own originator is reported
  // as-is: the plugin no longer special-cases that string.
  assert.equal(resolveSessionEntrypoint({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode' }), 'codex_vscode');
});

test('accepted edge: a desktop app started from an editor terminal reports the editor', () => {
  assert.equal(
    resolveSessionEntrypoint({ ...VSCODE_TERMINAL, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }),
    'ide-vscode',
  );
});

test('an editor beats the declared fallback', () => {
  assert.equal(resolveSessionEntrypoint({ ...VSCODE_TERMINAL, REVA_SESSION_ENTRYPOINT: 'cli' }), 'ide-vscode');
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
  assert.equal(resolveSessionEntrypoint({ REVA_SESSION_ENTRYPOINT: 'cli' }), 'cli');
  assert.equal(resolveSessionEntrypoint({ REVA_SESSION_ENTRYPOINT: '  ' }), UNKNOWN_ENTRYPOINT);
});

test('a detected surface always beats the declared fallback', () => {
  // Otherwise a value exported for the CLI would mislabel a desktop session
  // that inherited the same environment.
  assert.equal(
    resolveSessionEntrypoint({
      REVA_SESSION_ENTRYPOINT: 'cli',
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
