# Desktop compatibility: Codex surfaces

This plugin governs **Codex** on every surface that runs Codex plugin hooks on your
machine — the CLI, the desktop app and IDE integrations — identically. This page states
where the line is drawn, how the plugin tells surfaces apart, what that changes, and how
that is verified.

## Which surfaces are governed

| Surface | Governed | `context.sessionEntryPoint` |
|---|---|---|
| Codex desktop app | yes | `Codex Desktop` |
| Codex CLI installed through npm, bun or pnpm — including `codex exec` | yes | `codex-cli` |
| Codex VS Code extension, and other integrations that load Codex plugin hooks | yes | whatever the host reports; `unknown` if it reports nothing |
| Standalone CLI binary (Homebrew, direct download) | yes | `unknown`, unless you set `REVA_SESSION_ENTRYPOINT` |
| Any other host that loads Codex plugins, including ones that do not exist yet | yes | the host's own name, if it gives one |
| Codex **cloud** tasks | **no** | — |

Codex cloud tasks run in OpenAI's environment, not on your machine, so a locally installed
plugin is never invoked for them. That is a limitation of where the work runs, not a choice
by this plugin.

A Git repository is not required on any surface.

## How the distinction is made

The surface is identified from **markers Codex and its launcher put in the hook's
environment** — never tool names, never workspace paths. See `resolveSessionEntrypoint()`
in [`src/identity.ts`].

Four signals, in this precedence:

1. **`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`**, when Codex sets it, is reported **verbatim**.
   The desktop app sets `Codex Desktop`. Passing the value through unchanged means a new
   surface reports itself rather than being bucketed into a known one.
2. **A package-manager launcher marker** — `CODEX_MANAGED_PACKAGE_ROOT`, or
   `CODEX_MANAGED_BY_NPM` / `_BUN` / `_PNPM` — reports `codex-cli`. The npm, bun and pnpm
   launchers all set these; `codex exec` goes through the same launcher, so it reports
   `codex-cli` too.
3. **`REVA_SESSION_ENTRYPOINT`**, if you set it, fills the gap when neither marker exists.
4. Otherwise, **`unknown`**.

Two consequences follow, and both are tested:

- **A detected surface always wins over a declared one.** `REVA_SESSION_ENTRYPOINT`. 
   The variable is checked last on purpose. If you set it for the CLI, a desktop session that inherits 
   the same environment still reports Codex Desktop, not your value.
- **unknown is still fully governed** It only means Codex gave no marker. 
   For example, a Homebrew install of Codex has no launcher wrapper, so it 
   reports unknown where an npm install of the same version reports codex-cli. 
   Every action is still checked.


## What a hook does on an excluded surface

 Every registered hook — `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse` — plus the detached MCP-ingestion process
(`dist/src/ingestMcpServers.js`) behaves the same way:

- reads the hook payload and loads the Reva configuration;
- fails **closed** (exit 2, action blocked) if the token or account id is missing, or the
  payload is malformed;
- sends the evaluation to Reva and enforces the answer — exit 0 to allow, exit 2 with a
  reason to deny;
- records the session, turn and spawn state in the plugin's data directory.

With `REVA_DEBUG=1`, every hook logs what it did to stderr and appends the same lines to
`debug.log` in the plugin's data directory
(`$CODEX_HOME/plugins/data/reva-security-reva-plugins`).

## Verification matrix

No combination of surface markers changes enforcement. That is held in place by the
following tests:

| What is verified | Test |
|---|---|
| Precedence: `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, then a launcher marker (`CODEX_MANAGED_PACKAGE_ROOT`, `CODEX_MANAGED_BY_NPM` / `_BUN` / `_PNPM`), then `REVA_SESSION_ENTRYPOINT`, then `unknown` | [`test/identity.test.ts`](../test/identity.test.ts) |
| An originator is passed through verbatim, including one the plugin has never seen | [`test/identity.test.ts`](../test/identity.test.ts) |
| A detected surface is never relabelled by `REVA_SESSION_ENTRYPOINT` | [`test/identity.test.ts`](../test/identity.test.ts) |
| The real `sessionStart.js` records `Codex Desktop`, `codex-cli` and `unknown` correctly | [`test/sessionStart.test.ts`](../test/sessionStart.test.ts) |
| Through the real hook processes: a 200 allows, a 403 denies, malformed input and a missing token fail **closed** (exit 2) | [`test/hookOutput.test.ts`](../test/hookOutput.test.ts) |
| A missing account id fails closed rather than falling back to a machine id | [`test/config.test.ts`](../test/config.test.ts) |
| An unrecognised tool is evaluated as `invokeTool`, never dropped | [`test/mapping.test.ts`](../test/mapping.test.ts) |
| `hooks/hooks.json` registers exactly the five intended hooks, and its matchers select every governed tool | [`test/hooksConfig.test.ts`](../test/hooksConfig.test.ts) |

The surface value is computed separately from the decision path, so no surface — including
`unknown` — can bypass a check. The real-process decision tests run with every surface
marker unset; surface detection itself is tested at the unit level.

## Rollout

This is version **1.1.0** of the plugin (`.codex-plugin/plugin.json`). An older installed
or cached copy keeps running its own older code, so confirm the installed version before
concluding how a surface is reported. To reinstall:

```bash
codex plugin remove reva-security@reva-plugins
codex plugin marketplace remove reva-plugins

//check
codex plugin marketplace add https://github.com/reva-ai/reva-codex-authorization.git
codex plugin add reva-security@reva-plugins
```
//remove if --config works
Your token stays in `~/.codex/config.toml` under `[reva]` — Codex has no install-time
`--config` option the plugin can read, so nothing needs re-entering.

Start a fresh Codex session afterwards — configuration and plugin code are read at session start.
