import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  DELETE_ACTION,
  MAX_BASH_RESOURCES,
  canonicalToolName,
  extractShellTargets,
  mapToolToCedar,
  parseApplyPatchTargets,
} from '../src/mapping';

// A throwaway git repo so toPortableId() produces "<repoName>/<relative>"
// exactly as it would on a developer machine. Files must really exist,
// because the candidate test treats "resolves to something on disk" as its
// strongest signal.
function makeRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-map-'));
  const repo = path.join(root, 'domain-services');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  for (const dir of ['routes', 'controllers', 'models']) {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(repo, 'server.js'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'routes', 'songRoutes.js'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'routes', 'likedRoutes.js'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'controllers', 'albumController.js'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'models', 'user.js'), '', 'utf8');
  fs.writeFileSync(path.join(repo, 'Makefile'), '', 'utf8');
  return { root: repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function ids(command: string, cwd: string): string[] {
  return mapToolToCedar('Bash', { command }, cwd).mappings.map((m) => m.resourceId);
}

// ---------------------------------------------------------------------------
// PowerShell command strings taken VERBATIM from a real Codex 0.151.0 capture
// on Windows 11 (gpt-5.6-terra, permission_mode "default"). These four are the
// regression fixtures for the POSIX->PowerShell heuristic rewrite.
// ---------------------------------------------------------------------------

test('captured: Get-Content -Raw with a backslash path, -Raw is not a resource', { skip: process.platform !== 'win32' }, (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.deepEqual(ids('Get-Content -Raw controllers\\albumController.js', repo.root), [
    'domain-services/controllers/albumController.js',
  ]);
});

test('captured: comma-separated path list yields every directory', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  // Select-Object's FullName,Name are property names, not paths, and neither
  // exists on disk — they must not become resources.
  assert.deepEqual(ids('Get-ChildItem routes,controllers,models | Select-Object FullName,Name', repo.root), [
    'domain-services/routes',
    'domain-services/controllers',
    'domain-services/models',
  ]);
});

test('captured: -ErrorAction SilentlyContinue value is not mistaken for a path', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.deepEqual(ids('Get-Content routes/likedRoutes.js -ErrorAction SilentlyContinue', repo.root), [
    'domain-services/routes/likedRoutes.js',
  ]);
});

test('captured: a quoted rg regex containing pipes is neither split nor treated as a path', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  // The "." argument is a real directory and SHOULD be picked up; the regex
  // must not be, and its pipes must not split the command into segments.
  assert.deepEqual(ids('rg -n "liked|Like|songRoutes|router" -S .', repo.root), ['domain-services']);
});

test('an expression that merely looks path-shaped is excluded', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  // node -e "require('./routes/likedRoutes')" contains a slash but is code,
  // not a path, and does not exist on disk.
  const mapping = mapToolToCedar('Bash', { command: `node -e "require('./routes/likedRoutes')"` }, repo.root);
  assert.equal(mapping.candidateCount, 0);
  assert.deepEqual(mapping.mappings.map((m) => m.resourceId), ['domain-services']);
  assert.equal(mapping.mappings[0].resourceType, 'Directory');
});

test('a command with no path arguments falls back to the working directory', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const mapping = mapToolToCedar('Bash', { command: 'git diff' }, repo.root);
  assert.equal(mapping.candidateCount, 0);
  assert.deepEqual(mapping.mappings.map((m) => m.resourceId), ['domain-services']);
});

test('chained commands produce one resource per distinct path, deduped', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const command =
    'Get-Content server.js; Get-Content routes/songRoutes.js; Get-ChildItem models; Get-Content server.js';
  assert.deepEqual(ids(command, repo.root), [
    'domain-services/server.js',
    'domain-services/routes/songRoutes.js',
    'domain-services/models',
  ]);
});

test('every executeBash mapping carries the full real command string', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const command = 'Get-Content server.js; Get-ChildItem models';
  const mapping = mapToolToCedar('Bash', { command }, repo.root);
  assert.equal(mapping.mappings.length, 2);
  for (const m of mapping.mappings) {
    assert.equal(m.actionName, 'executeBash');
    assert.equal(m.command, command);
  }
});

test('over the resource cap: denied outright, never degraded to a coarser resource', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const many = Array.from({ length: MAX_BASH_RESOURCES + 2 }, (_, i) => `f${i}.txt`);
  for (const f of many) fs.writeFileSync(path.join(repo.root, f), '', 'utf8');
  const mapping = mapToolToCedar('Bash', { command: `Get-Content ${many.join(',')}` }, repo.root);
  assert.equal(mapping.overCap, true);
  assert.equal(mapping.candidateCount, MAX_BASH_RESOURCES + 2);
  // Crucially NOT a common-ancestor fallback — no resource at all, so the
  // caller has nothing it could accidentally evaluate as if it were the set.
  assert.deepEqual(mapping.mappings, []);
});

test('at exactly the cap the call is still evaluated', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const many = Array.from({ length: MAX_BASH_RESOURCES }, (_, i) => `g${i}.txt`);
  for (const f of many) fs.writeFileSync(path.join(repo.root, f), '', 'utf8');
  const mapping = mapToolToCedar('Bash', { command: `Get-Content ${many.join(',')}` }, repo.root);
  assert.equal(mapping.overCap, undefined);
  assert.equal(mapping.mappings.length, MAX_BASH_RESOURCES);
});

test('tilde is expanded, so a file outside the repo gets no Repository ancestor', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const mapping = mapToolToCedar('Bash', { command: 'Set-Content ~/Desktop/escape.txt' }, repo.root);
  const outside = mapping.mappings[0];
  // Regression guard for the documented tilde bypass: without expansion this
  // resolves INSIDE the repo and wrongly inherits Repository::"domain-services".
  assert.ok(path.isAbsolute(outside.resourceId), `expected an absolute id, got ${outside.resourceId}`);
  assert.deepEqual(outside.resourceParents, []);
});

test('wildcards never leak into a resource id', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  for (const id of ids('Get-ChildItem models/*.js', repo.root)) {
    assert.ok(!id.includes('*'), `resource id must not contain a wildcard: ${id}`);
  }
});

test('an extensionless file that exists is a File, not a Directory', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const mapping = mapToolToCedar('Bash', { command: 'Get-Content Makefile' }, repo.root);
  assert.equal(mapping.mappings[0].resourceType, 'File');
});

test('ancestor chain is flat and complete, repo root last', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const mapping = mapToolToCedar('Bash', { command: 'Get-Content routes/songRoutes.js' }, repo.root);
  assert.deepEqual(mapping.mappings[0].resourceParents, [
    { type: 'Directory', id: 'domain-services/routes' },
    { type: 'Directory', id: 'domain-services' },
    { type: 'Repository', id: 'domain-services' },
  ]);
});

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

test('apply_patch: Add is write, Update is edit', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const patch = [
    '*** Begin Patch',
    '*** Add File: routes/likedRoutes.js',
    '+const x = 1;',
    '*** Update File: models/user.js',
    '@@',
    '+liked: []',
    '*** End Patch',
  ].join('\n');
  const mapping = mapToolToCedar('apply_patch', { command: patch }, repo.root);
  assert.deepEqual(
    mapping.mappings.map((m) => [m.actionName, m.resourceId]),
    [
      ['write', 'domain-services/routes/likedRoutes.js'],
      ['edit', 'domain-services/models/user.js'],
    ],
  );
  for (const m of mapping.mappings) assert.equal(m.resourceType, 'File');
});

test('apply_patch: the captured three-mutation call yields three resources', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  // Shape of the real capture: one PreToolUse event, three file mutations.
  const patch = [
    '*** Begin Patch',
    '*** Add File: routes/likedRoutes.js',
    '+router',
    '*** Update File: models/user.js',
    '@@',
    '+liked',
    '*** Update File: server.js',
    '@@',
    '+app.use',
    '*** End Patch',
  ].join('\n');
  const mapping = mapToolToCedar('apply_patch', { command: patch }, repo.root);
  assert.equal(mapping.mappings.length, 3);
  assert.equal(mapping.candidateCount, 3);
  // Uncapped: every path is exact and every one is a mutation.
  assert.equal(mapping.overCap, undefined);
});

test('apply_patch: Delete maps through the DELETE_ACTION constant', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const patch = ['*** Begin Patch', '*** Delete File: models/user.js', '*** End Patch'].join('\n');
  const targets = parseApplyPatchTargets(patch, repo.root);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].actionName, DELETE_ACTION);
});

test('apply_patch: Move is two resources — removal at source, write at destination', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const patch = [
    '*** Begin Patch',
    '*** Update File: models/user.js',
    '*** Move to: models/account.js',
    '@@',
    '+renamed',
    '*** End Patch',
  ].join('\n');
  const mapping = mapToolToCedar('apply_patch', { command: patch }, repo.root);
  assert.deepEqual(
    mapping.mappings.map((m) => [m.actionName, m.resourceId]),
    [
      [DELETE_ACTION, 'domain-services/models/user.js'],
      ['write', 'domain-services/models/account.js'],
    ],
  );
});

test('apply_patch: absolute and repo-relative paths resolve to the same portable id', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const relative = ['*** Begin Patch', '*** Update File: server.js', '*** End Patch'].join('\n');
  const absolute = [
    '*** Begin Patch',
    `*** Update File: ${path.join(repo.root, 'server.js')}`,
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(
    mapToolToCedar('apply_patch', { command: relative }, repo.root).mappings.map((m) => m.resourceId),
    mapToolToCedar('apply_patch', { command: absolute }, repo.root).mappings.map((m) => m.resourceId),
  );
});

test('apply_patch: an unparseable envelope yields no resource, so the caller fails closed', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const mapping = mapToolToCedar('apply_patch', { command: 'not a patch at all' }, repo.root);
  assert.deepEqual(mapping.mappings, []);
  assert.equal(mapping.candidateCount, 0);
});

// ---------------------------------------------------------------------------
// Other tools
// ---------------------------------------------------------------------------

// A nonexistent path, passed explicitly, so these tests never depend on
// whatever config.toml happens to exist on the machine running them.
const NO_CONFIG = path.join(os.tmpdir(), 'reva-governance-mapping-no-such-config.toml');

test('MCP tools map to invokeTool with an MCPServer parent', () => {
  const mapping = mapToolToCedar('mcp__github__search_repositories', { query: 'anthropic' }, process.cwd(), NO_CONFIG);
  assert.equal(mapping.mappings.length, 1);
  const m = mapping.mappings[0];
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceType, 'Tool');
  assert.equal(m.resourceId, 'github/search_repositories');
  assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'github' }]);
});

test('MCP server tokens are slugified so config keys and tool names converge', () => {
  const mapping = mapToolToCedar('mcp__My_Server__list_things', {}, process.cwd(), NO_CONFIG);
  assert.equal(mapping.mappings.length, 1);
  const m = mapping.mappings[0];
  assert.equal(m.resourceId, 'my-server/list_things');
  assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'my-server' }]);
});

// --- skipReason: an MCP server with no known url is never evaluated -------
// (see types.ts's own comment on skipReason and ingestionClient.ts, which
// never ingests one of these in the first place).

test('an MCP server not in config.toml at all gets skipReason set', () => {
  const mapping = mapToolToCedar('mcp__github__search_repositories', {}, process.cwd(), NO_CONFIG);
  assert.match(String(mapping.mappings[0].skipReason), /github/);
  assert.match(String(mapping.mappings[0].skipReason), /no known URL/);
});

test('an MCP server with a url in config.toml has no skipReason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-mapping-mcp-'));
  try {
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, ['[mcp_servers.github]', 'url = "https://api.githubcopilot.com/mcp/"'].join('\n'), 'utf8');
    const mapping = mapToolToCedar('mcp__github__search_repositories', {}, process.cwd(), configPath);
    assert.equal(mapping.mappings[0].skipReason, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stdio server declared in config.toml (no url) still gets skipReason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-mapping-mcp-stdio-'));
  try {
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, ['[mcp_servers.local]', 'command = "node"'].join('\n'), 'utf8');
    const mapping = mapToolToCedar('mcp__local__run', {}, process.cwd(), configPath);
    assert.ok(mapping.mappings[0].skipReason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn_agent maps to spawn on a SubAgent', () => {
  const mapping = mapToolToCedar('spawn_agent', { agent_type: 'explorer' }, process.cwd());
  assert.equal(mapping.mappings[0].actionName, 'spawn');
  assert.equal(mapping.mappings[0].resourceType, 'SubAgent');
  assert.equal(mapping.mappings[0].resourceId, 'explorer');
});

test('spawn_agent falls back honestly when no agent-type field is present', () => {
  // task_name is deliberately NOT used as an agent type — it names the task.
  const mapping = mapToolToCedar('spawn_agent', { task_name: 'find auth code' }, process.cwd());
  assert.equal(mapping.mappings[0].resourceId, 'subagent');
});

test('the namespaced hook name collaborationspawn_agent maps to spawn on a SubAgent', () => {
  // Real tool_name captured from Codex CLI 0.162.1: namespace "collaboration"
  // + name "spawn_agent", concatenated with no separator. Real tool_input
  // shape from the same capture (no agent-type field).
  const toolName = canonicalToolName('collaborationspawn_agent');
  assert.equal(toolName, 'spawn_agent');
  const mapping = mapToolToCedar(toolName, { task_name: 'identify_ts_files', fork_turns: 'all', message: 'x' }, process.cwd());
  assert.equal(mapping.mappings[0].actionName, 'spawn');
  assert.equal(mapping.mappings[0].resourceType, 'SubAgent');
  assert.equal(mapping.mappings[0].resourceId, 'subagent');
});

test('canonicalToolName only rewrites exact known namespaced names', () => {
  assert.equal(canonicalToolName('spawn_agent'), 'spawn_agent');
  assert.equal(canonicalToolName('Bash'), 'Bash');
  assert.equal(canonicalToolName('mcp__srv__spawn_agent'), 'mcp__srv__spawn_agent');
  assert.equal(canonicalToolName('myspawn_agent'), 'myspawn_agent');
  assert.equal(canonicalToolName('collaborationspawn_agent_v2'), 'collaborationspawn_agent_v2');
});

test('an unrecognized tool still produces a resource rather than being dropped', () => {
  const mapping = mapToolToCedar('some_other_tool', {}, process.cwd());
  assert.equal(mapping.mappings[0].actionName, 'invokeTool');
  assert.equal(mapping.mappings[0].resourceId, 'some_other_tool');
});

test('extractShellTargets returns absolute, deduped paths in first-seen order', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const targets = extractShellTargets('Get-Content server.js; Get-Content server.js; Get-ChildItem routes', repo.root);
  assert.equal(targets.length, 2);
  for (const target of targets) assert.ok(path.isAbsolute(target));
});

// Reproduces the D:\drivers deletion from a live Codex session: one
// delete-and-verify script whose quoted status messages contain a path.
test('quoted status messages containing a path are not resources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-msg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const drivers = path.join(root, 'drivers');
  fs.mkdirSync(drivers);
  const command =
    `Remove-Item -Recurse -Force ${drivers}\n` +
    `if (Test-Path ${drivers}) { Write-Output "Deletion verification failed: ${drivers} still exists." } ` +
    `else { Write-Output "Deleted ${drivers} successfully." }`;
  assert.deepEqual(extractShellTargets(command, root), [drivers]);
});

test('a quoted message with a path is dropped for echo and Write-Host too', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const dir = path.join(repo.root, 'routes');
  assert.deepEqual(extractShellTargets(`echo "Removed ${dir} successfully."`, repo.root), []);
  assert.deepEqual(extractShellTargets(`Write-Host 'Cleaned ${dir} now'`, repo.root), []);
});

test('an existing quoted path with spaces is still a resource', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const spaced = path.join(repo.root, 'Program Files');
  fs.mkdirSync(spaced);
  fs.writeFileSync(path.join(spaced, 'app.exe'), '', 'utf8');
  assert.deepEqual(extractShellTargets(`Remove-Item "${path.join(spaced, 'app.exe')}"`, repo.root), [
    path.join(spaced, 'app.exe'),
  ]);
});

test('a NEW quoted file with spaces under an existing folder is still a resource', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const target = path.join(repo.root, 'routes', 'new file.js');
  assert.deepEqual(extractShellTargets(`Set-Content "${target}" "x"`, repo.root), [target]);
});

test('a relative quoted path with spaces in the cwd is still a resource', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  assert.deepEqual(extractShellTargets(`New-Item "my notes.txt"`, repo.root), [path.join(repo.root, 'my notes.txt')]);
});

// Reproduces the D:\namasteReact deletion from a live Codex session: bare
// PowerShell string output, no path separator inside the message.
test('a quoted message with no separator is not a resource, even though cwd exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-msg2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'namasteReact');
  fs.mkdirSync(target);
  const command =
    `Remove-Item -LiteralPath '${target}' -Recurse -Force; if (Test-Path -LiteralPath '${target}') ` +
    `{ 'Delete failed: folder still exists' } else { 'Deleted: ${target}' }`;
  assert.deepEqual(extractShellTargets(command, root), [target]);
  assert.deepEqual(extractShellTargets(`Write-Output 'Done. See log'`, root), []);
});

test('a NEW quoted folder with spaces under an existing folder is still a resource', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const target = path.join(repo.root, 'routes', 'New Folder');
  assert.deepEqual(extractShellTargets(`New-Item -ItemType Directory "${target}"`, repo.root), [target]);
});
