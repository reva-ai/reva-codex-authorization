import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

// Guards the shipped hooks/hooks.json. Everything asserted here was learned
// by breaking it in a live Codex session, so these are regression tests, not
// style checks.

const hooksPath = path.resolve(__dirname, '../../hooks/hooks.json');
const raw = fs.readFileSync(hooksPath);
const doc = JSON.parse(raw.toString('utf8'));
const handlers = Object.values(doc.hooks as Record<string, any[]>).flatMap((groups) =>
  groups.flatMap((g) => g.hooks as any[]),
);

test('no BOM — Codex’s Rust parser rejects one outright', () => {
  assert.ok(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));
});

test('registers exactly the five intended events', () => {
  assert.deepEqual(Object.keys(doc.hooks).sort(), [
    'PostToolUse',
    'PreToolUse',
    'SessionEnd',
    'SessionStart',
    'UserPromptSubmit',
  ]);
  assert.equal(handlers.length, 5);
});

test('every Windows command propagates the child exit code', () => {
  // `powershell -Command node <script>` DISCARDS the native exit code and
  // reports 1 for any failure. Codex derives the hook shell from the session
  // shell, which on Windows is PowerShell — so without this suffix every
  // deny (exit 2) arrives as exit 1, a NON-BLOCKING failure, and the denied
  // tool call proceeds. Observed live.
  for (const h of handlers) {
    assert.ok(
      h.commandWindows?.includes('; exit $LASTEXITCODE'),
      `commandWindows must end with "; exit $LASTEXITCODE": ${h.commandWindows}`,
    );
  }
});

test('Windows uses PowerShell env syntax, POSIX uses sh syntax', () => {
  for (const h of handlers) {
    assert.ok(h.commandWindows.includes('$env:PLUGIN_ROOT'), `Windows must use $env:PLUGIN_ROOT: ${h.commandWindows}`);
    assert.ok(!h.commandWindows.includes('%PLUGIN_ROOT%'), 'cmd-style %VAR% does not expand in PowerShell');
    assert.ok(h.command.includes('$PLUGIN_ROOT'), `POSIX must use $PLUGIN_ROOT: ${h.command}`);
    // sh propagates a child's exit code natively; the suffix would be noise.
    assert.ok(!h.command.includes('LASTEXITCODE'));
  }
});

test('script paths are quoted, so an install path containing a space still works', () => {
  for (const h of handlers) {
    assert.match(h.command, /node "\$PLUGIN_ROOT\/dist\/src\/\w+\.js"/);
    assert.match(h.commandWindows, /node "\$env:PLUGIN_ROOT\/dist\/src\/\w+\.js"/);
  }
});

test('no handler is async — an async hook cannot block', () => {
  // can_apply_control_effects() is false for async handlers, so their exit 2
  // is ignored entirely and enforcement silently stops.
  for (const h of handlers) {
    assert.notEqual(h.async, true);
  }
});

test('every handler is a command hook with a timeout above the RTG timeout', () => {
  for (const h of handlers) {
    assert.equal(h.type, 'command');
    assert.ok(typeof h.timeout === 'number' && h.timeout > 0);
  }
  // The blocking hooks must outlast a 25s RTG timeout plus overhead.
  for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
    for (const g of doc.hooks[event]) {
      for (const h of g.hooks) assert.ok(h.timeout >= 45, `${event} timeout too tight: ${h.timeout}`);
    }
  }
});

test('tool matchers cover every governed tool', () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const matcher = doc.hooks[event][0].matcher as string;
    const re = new RegExp(matcher);
    for (const tool of ['Bash', 'apply_patch', 'spawn_agent', 'mcp__github__search_repositories']) {
      assert.ok(re.test(tool), `${event} matcher must select ${tool}`);
    }
  }
});

test('SessionStart is scoped to real session starts, UserPromptSubmit to every prompt', () => {
  assert.equal(doc.hooks.SessionStart[0].matcher, 'startup|resume');
  assert.equal(doc.hooks.UserPromptSubmit[0].matcher, undefined);
});

test('SessionEnd uses a short timeout for local cleanup only', () => {
  assert.equal(doc.hooks.SessionEnd[0].matcher, undefined);
  assert.equal(doc.hooks.SessionEnd[0].hooks[0].timeout, 5);
});
