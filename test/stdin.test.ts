import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';

// readStdin() only resolves on stdin 'end', so it is exercised through a real
// child process rather than by faking process.stdin.
function echoStdin(payload: Buffer | string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', `require(${JSON.stringify(path.resolve(__dirname, '../src/stdin.js'))}).readStdin().then(s => process.stdout.write(s))`],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
    child.once('error', reject);
    child.once('close', () => resolve(out));
    child.stdin.end(payload);
  });
}

test('plain JSON passes through untouched', async () => {
  assert.equal(await echoStdin('{"a":1}'), '{"a":1}');
});

test('a leading UTF-8 BOM is stripped so the payload stays parseable', async () => {
  // PowerShell 5.1 prepends this when piping a file into a native process,
  // which would otherwise fail closed with a confusing JSON error.
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]);
  const result = await echoStdin(withBom);
  assert.equal(result, '{"a":1}');
  assert.deepEqual(JSON.parse(result), { a: 1 });
});

test('only ONE leading BOM is removed — a second is left to fail loudly', async () => {
  const doubled = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]);
  const result = await echoStdin(doubled);
  assert.equal(result.charCodeAt(0), 0xfeff, 'a second BOM must survive rather than be silently swallowed');
  assert.throws(() => JSON.parse(result));
});

test('a BOM-like character mid-payload is not touched', async () => {
  const payload = '{"a":"x﻿y"}';
  assert.equal(await echoStdin(payload), payload);
});

test('empty stdin resolves to an empty string rather than hanging', async () => {
  assert.equal(await echoStdin(''), '');
});
