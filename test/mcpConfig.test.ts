import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseAllMcpServersToml, parseMcpServersToml, readAllMcpServers, readRemoteMcpServers } from '../src/mcpConfig';

// The governing rule for every case below: on anything the reader does not
// understand, SKIP the entry. Under-ingesting is benign; writing a wrong
// baseUrl into a customer's entity store is not.

test('reads url-bearing [mcp_servers.<name>] tables', () => {
  const toml = [
    '[mcp_servers.docs]',
    'url = "https://docs.example.com/mcp"',
    '',
    '[mcp_servers.search]',
    "url = 'https://search.example.com/mcp'",
  ].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), [
    { name: 'docs', url: 'https://docs.example.com/mcp' },
    { name: 'search', url: 'https://search.example.com/mcp' },
  ]);
});

test('a stdio server has no url and is skipped rather than given a fabricated one', () => {
  const toml = ['[mcp_servers.local]', 'command = "node"', 'args = ["server.js"]'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), []);
  assert.deepEqual(parseAllMcpServersToml(toml), [{ name: 'local' }]);
});

test('tables outside mcp_servers are ignored even when they have a url', () => {
  const toml = ['[some_other_thing]', 'url = "https://not-an-mcp-server.example.com"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), []);
});

test('a url inside a SUB-table is not attributed to the server', () => {
  // [mcp_servers.foo.env]'s keys belong to `env`, not to foo. Reading this
  // url as foo's baseUrl would be exactly the mis-ingestion to avoid.
  const toml = ['[mcp_servers.foo]', 'command = "node"', '', '[mcp_servers.foo.env]', 'url = "https://not-foo.example.com"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), []);
});

test('a quoted server name is read whole', () => {
  const toml = ['[mcp_servers."my.server"]', 'url = "https://example.com/mcp"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), [{ name: 'my-server', url: 'https://example.com/mcp' }]);
});

test('comments and blank lines are ignored', () => {
  const toml = [
    '# top level comment',
    '',
    '[mcp_servers.docs] # trailing comment',
    '# another',
    'url = "https://docs.example.com/mcp" # trailing',
  ].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), [{ name: 'docs', url: 'https://docs.example.com/mcp' }]);
});

test('shapes the reader does not model are skipped, never guessed', () => {
  for (const value of [
    'url = ["https://a.example.com"]', // array
    'url = { href = "https://a.example.com" }', // inline table
    'url = https://a.example.com', // bare, unquoted
    'url = """https://a.example.com"""', // multi-line string
    'url = ""', // empty
  ]) {
    const toml = ['[mcp_servers.docs]', value].join('\n');
    assert.deepEqual(parseMcpServersToml(toml), [], `should have skipped: ${value}`);
  }
});

test('an inline mcp_servers table is skipped rather than half-parsed', () => {
  const toml = 'mcp_servers = { docs = { url = "https://docs.example.com/mcp" } }';
  assert.deepEqual(parseMcpServersToml(toml), []);
});

test('an array-of-tables header is not treated as a server table', () => {
  const toml = ['[[mcp_servers.docs]]', 'url = "https://docs.example.com/mcp"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), []);
});

test('an unterminated quote in a header is not understood', () => {
  const toml = ['[mcp_servers."broken]', 'url = "https://example.com/mcp"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), []);
});

test('mixed remote and stdio servers yields only the remote ones', () => {
  const toml = [
    '[mcp_servers.local]',
    'command = "node"',
    '[mcp_servers.remote]',
    'url = "https://remote.example.com/mcp"',
    '[mcp_servers.another_local]',
    'command = "python"',
  ].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), [{ name: 'remote', url: 'https://remote.example.com/mcp' }]);
  assert.deepEqual(parseAllMcpServersToml(toml), [
    { name: 'local' },
    { name: 'remote', url: 'https://remote.example.com/mcp' },
    { name: 'another-local' },
  ]);
});

test('a missing config.toml is the common case and yields an empty list', () => {
  assert.deepEqual(readRemoteMcpServers(path.join(os.tmpdir(), 'definitely-not-here-4f2a', 'config.toml')), []);
});

test('readRemoteMcpServers reads a real file from disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-toml-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, '[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n', 'utf8');
  assert.deepEqual(readRemoteMcpServers(file), [{ name: 'docs', url: 'https://docs.example.com/mcp' }]);
});

test('mcp_servers table names are slugified', () => {
  const toml = ['[mcp_servers.My_Server]', 'url = "https://example.com/mcp"'].join('\n');
  assert.deepEqual(parseMcpServersToml(toml), [{ name: 'my-server', url: 'https://example.com/mcp' }]);
});
