import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMcpServerIdentity, slugifyMcpServerName } from '../src/mcpServerIdentity';

test('slugifies config-style and tool-name tokens into one format', () => {
  assert.equal(slugifyMcpServerName('github'), 'github');
  assert.equal(slugifyMcpServerName('My_Server'), 'my-server');
  assert.equal(slugifyMcpServerName('My  Server'), 'my-server');
  assert.equal(slugifyMcpServerName('some.dotted.name'), 'some-dotted-name');
  assert.equal(slugifyMcpServerName('  Padded  '), 'padded');
  assert.equal(slugifyMcpServerName('already-a-slug'), 'already-a-slug');
});

test('resolve always slugifies — one id across config.toml and mcp__ tool names', () => {
  assert.equal(resolveMcpServerIdentity('My_Server').slug, 'my-server');
  assert.equal(resolveMcpServerIdentity('my-server').slug, 'my-server');
  assert.equal(resolveMcpServerIdentity('github').slug, 'github');
  assert.equal(resolveMcpServerIdentity('Claude_Browser').slug, 'claude-browser');
});

test('resolve carries a url straight through when the caller already knows it', () => {
  const identity = resolveMcpServerIdentity('github', 'https://api.githubcopilot.com/mcp/');
  assert.equal(identity.slug, 'github');
  assert.equal(identity.url, 'https://api.githubcopilot.com/mcp/');
});

test('resolve with no url given is definitively no url, not a guess', () => {
  assert.equal(resolveMcpServerIdentity('github').url, undefined);
});

test('slugging is many-to-one, and that collapse is symmetric', () => {
  assert.equal(resolveMcpServerIdentity('my_server').slug, 'my-server');
  assert.equal(resolveMcpServerIdentity('my-server').slug, 'my-server');
  assert.equal(resolveMcpServerIdentity('My.Server').slug, 'my-server');
});
