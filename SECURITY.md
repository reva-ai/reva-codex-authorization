# Security

## Reporting a vulnerability

Email **info@reva.ai** with "SECURITY" in the subject. Please include what you found, how to
reproduce it, and what an attacker could do with it. Please do not open a public issue for
anything exploitable.

We will acknowledge within 3 business days and keep you updated until it is resolved. If you
would like credit in the release notes, say so and we will include it.

## What this software is, in security terms

This is an **authorization enforcement point that runs on a developer's workstation**. Codex
invokes it through five hooks — `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse` and `SessionEnd` — and on `UserPromptSubmit` and `PreToolUse` its answer
decides whether the turn or the tool call runs at all.

It is not a passive audit log. It sees the developer's prompts and the arguments of every
governed tool call, and it sends them to a Reva Policy Decision Point over HTTPS to be
evaluated.

**Read the next section before deploying this to a team.** A tool that transmits prompts,
command text and file contents off the workstation is a meaningful change to a developer's
environment, and the people running it are entitled to know exactly what leaves their
machine.

## What it sends, and what it keeps

Every evaluation is a request to `https://<REVA_HOST>/pdp/v2/ai/evaluation`. The table below
is the complete set of content that leaves the machine.

| Hook | Content transmitted |
|---|---|
| `UserPromptSubmit` | The **full text of the prompt** the developer submitted, truncated to 10000 characters. |
| `PreToolUse` (shell, `Bash`) | The **full shell command**, verbatim and untruncated. On Windows this is the literal PowerShell command. |
| `PreToolUse` (`apply_patch`) | The **whole patch**, untruncated — which means **the content of every file being created** and the changed lines of every file being edited. |
| `PreToolUse` (MCP tool) | `JSON.stringify(tool_input)` — the full argument object passed to the MCP tool. |
| `PreToolUse` (`spawn_agent`) | The spawn input, including the **message handed to the sub-agent**. |
| `PostToolUse` | The **serialized tool response**, truncated to 10000 characters — i.e. command output, which includes the contents of any file the command read. |
| every tool evaluation | The current turn's user prompt, again (truncated to 10000 characters), as one `conversation` message. |

One tool call can produce **several** evaluation requests — one per file or path it touches
— and each carries the same content.

Alongside the content, each request carries identity and resource metadata:

| Field | Value | Source |
|---|---|---|
| principal | The developer's **email address** | the `email` claim of the `id_token` in `$CODEX_HOME/auth.json`; falls back to the **OS username** if absent, e.g. with API-key sign-in |
| subject / agent id | The ChatGPT **account id** | `chatgpt_user_id` (or `user_id`) from the same `id_token`, or `agent_id` / `REVA_AGENT_ID` when set |
| resource id | The file, directory, repository, tool or sub-agent acted on | See "Paths" below |
| context | Machine id, OS family (`Windows` / `Linux`), the Codex surface, and — only with `REVA_MODEL_CONTEXT=1` — the model slug | local |
| session | Session id, turn number, and a count of concurrent sessions on this machine | local |
| correlation ids | A per-chat **thread id** — the Codex session id, sent as `X-Reva-Thread-Id` — plus a per-turn trace id and a per-operation span id in the W3C `traceparent` header | local |

At **session start** the plugin also registers entities with Reva's ingestion API, at
`https://<REVA_HOST>/ingestion/v2`:

- the developer's email, this machine's **hardware id** (`IOPlatformUUID` on macOS,
  `/etc/machine-id` on Linux, `MachineGuid` on Windows — or a random id generated once and
  stored locally if none is readable), and the agent id;
- on the agent: the OS family and the **model slug** of the session;
- MCP servers from `[mcp_servers.<name>]` tables in `$CODEX_HOME/config.toml`.

For MCP servers, the plugin reads **only** each table's name and its `url`, and only a
url-bearing (remote) server is registered at all — by name and URL. A stdio server's
`command`, `args` and `env` are never read or transmitted, so credentials held in a stdio
server's `env` block do not leave the machine through this plugin, but a stdio server with no
url is also never registered or governed: its tool calls are never sent to the evaluation
endpoint either, since there is no entity for a policy to act on. A server whose tool is
invoked but which appears in no config file is registered by name only when it has a url;
otherwise it is left alone the same way.

### Paths

A resource id is normally **repo-relative** — `my-repo/src/index.ts` — so one policy applies
on every developer's machine.

It falls back to the **raw absolute path** in two cases: when no git repository root can be
found above the file, and when the path lies outside the repository root. Reading
`C:\Users\alice\.ssh\config` or editing a file in `~/Documents` therefore transmits the
absolute path, which on most systems contains the local username.

For shell commands, the paths are extracted from the command string by a best-effort
heuristic, so they may be broader or narrower than what the command actually touches. The
full command is sent regardless.

### What stays on the machine

Turn caches, spawn counters, the active-session list, the per-session 401 latch, the cached
machine id and the ingestion cache are written **only** to the plugin's data directory:

- for a plugin install, the directory Codex provides as `PLUGIN_DATA` —
  `$CODEX_HOME/plugins/data/reva-security-reva-plugins`;
- for hooks registered by hand in `$CODEX_HOME/hooks.json`, which Codex gives no data
  directory, `~/.codex-governance`.

Nothing is written to the repository.

With `REVA_DEBUG` on, the same directory also receives `debug.log`, which records mapped
actions and the RTG's full responses and **accumulates across sessions**. The token itself is
never logged — a missing-token diagnostic records only whether it was absent, empty, or set
and how long.

### What Reva does with it

Content is transmitted to the Reva tenant identified by `REVA_HOST` and evaluated there.
Retention, logging and decision-log contents are properties of **that tenant**, not of this
plugin. If your organization has a policy about where prompt text and source code may be
sent, that policy applies to the Reva tenant you point this at — confirm it before a team
rollout.

## What blocks, and what does not

"Pass through" means the hook exits 0 with no output, so Codex proceeds exactly as if the
plugin were not installed. A block is exit code 2 with the reason on stderr — the only
blocking signal Codex honours from a hook.

| Condition | Outcome |
|---|---|
| RTG returns 200 | **allow** |
| RTG returns 200 with `guardrails.outcome: conditional_allow` | **allow**, with the guardrail's reason passed to Codex as an advisory note — Codex hooks cannot prompt the developer |
| RTG returns 403 | **deny** — the action is blocked |
| RTG returns 401 (bad or expired token) | **pass through** — and latches that session open: the RTG is not called again for the rest of it and every action passes through. A new session calls again. |
| RTG returns 413 (payload too large) | **pass through** — this one request only |
| RTG returns 404 or 424 | **deny** — blocked while Reva is unavailable |
| RTG returns 5xx | **deny** — blocked while Reva is unavailable |
| Network error or timeout | **deny** — blocked while Reva is unavailable |
| RTG returns another 4xx, including 429 | **deny** |
| One tool call touches several resources | **deny if any one is denied** |
| A shell command touches more than 10 distinct paths | **deny**, with a request to split the command |
| A patch whose target files cannot be parsed | **deny** |
| Auth token missing | **deny — every action**, until configured |
| Agent id unresolvable (API-key sign-in, no `agent_id` set) | **deny — every action**, until configured |
| Internal plugin error (bad stdin, mapping bug) | **deny** |

Governance holds **through** a Reva-side outage: an unreachable, timing-out or erroring RTG
blocks every action rather than degrading to "no governance for that moment", and a plugin
that is misconfigured must likewise not silently permit everything while appearing to
govern.

Two conditions pass through. A **401** more often means a principal that is not provisioned
yet than a real security failure, so it fails open — but because failing open on every call
for as long as a bad token lasts would be indistinguishable from having no plugin, it also
latches a local circuit open for that session: no further RTG call is made in it, and no
retry storm follows. The latch is keyed by session, so it never silences a different session
— including one started after the problem was fixed — and starting a new session is how the
repair is picked up. It does not expire on its own. A **413** is about one oversized
request, not a sign that Reva is unavailable.

**Plan for the fail-closed case before a team rollout.** With the RTG unreachable, every
governed action is blocked, so an outage stops developers working. `REVA_DEBUG=1` records
the reason; uninstalling the plugin or un-trusting its hooks is the only local override.

A developer signed in to Codex with an **API key** rather than a ChatGPT account has no
resolvable account id, and is **blocked on every action** until `agent_id` (or
`REVA_AGENT_ID`) is set explicitly. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## What it does not cover

These are gaps in what Codex exposes to a hook, not settings. Know them before relying on
this plugin as a control.

- **Hooks run only once trusted.** Codex skips a plugin's hooks until the developer reviews
  and trusts them with `/hooks`, and **any edit to `hooks/hooks.json` un-trusts them again**.
  An untrusted plugin governs nothing and says nothing. Pre-trust through managed
  `requirements.toml` if governance must not depend on each developer's action.
- **The developer controls the workstation.** They can un-trust the hooks, uninstall the
  plugin, or edit its configuration. This plugin enforces policy on the agent; it is not a
  tamper-proof control against the person operating it.
- **Ungoverned paths.** Hosted web search fires no hook. Input written to an already-running
  shell session (`write_stdin`) fires no `PreToolUse`, so it reaches the shell without
  pre-evaluation. Codex **cloud** tasks run in OpenAI's environment and never invoke this
  plugin.
- **Reads look like shell commands.** Codex has no read or search tool; reading a file is a
  shell command and is governed as `executeBash`, not `read`.
- **`PostToolUse` is not an audit backstop.** Codex does not fire it for every call, so the
  post-evaluation cannot be relied on to record every action.
- **On Windows, hand-registered hooks must propagate the exit code.** PowerShell reports a
  hook's exit 2 as 1 unless the command ends with `; exit $LASTEXITCODE`, and Codex treats
  1 as a non-blocking failure — so every deny would be ignored. The bundled `hooks.json`
  does this; a hand-written one must too. See [docs/INSTALL.md](docs/INSTALL.md).

## Controls, and what each one actually buys you

**The auth token is the only credential.** One token authenticates both evaluation and
ingestion. Codex's plugin manifest has no `sensitive` config field, so **there is no OS
keychain storage**: in `~/.codex/config.toml` the token is a plaintext value in a file
readable by the developer's account; as `REVA_AUTH_TOKEN` it is as exposed as any other
environment variable. Restrict the file's permissions, keep the token out of any
`config.toml` that is shared or checked in, and for a team rollout let your secrets manager
populate one or the other.

**Do not place the token under `[shell_environment_policy]`.** That table feeds the
environment of the model's shell tool, not the hooks — the plugin never sees it, while the
model's commands could.

**Transport.** HTTPS for every host except `localhost`, `127.0.0.1` and `[::1]`, which use
plain HTTP so a local mock RTG works for testing. A non-local host is always HTTPS; that
cannot be turned off.

**No runtime dependencies.** The plugin uses only the Node standard library. TypeScript and
`@types/node` are dev dependencies. There is no runtime supply chain to compromise. Note
that `dist/` is not committed: the code Codex runs is compiled on the workstation by
`npm install`, so the integrity of that clone and of the build toolchain matters.

**Hooks cannot escalate.** Every hook is a short-lived `node` process reading JSON on stdin
and signalling its decision through its exit code. It runs as the developer, with no
elevation, and its only network egress is to `REVA_HOST`. The session-start hook may start
one detached background `node` process for MCP registration, with the same privileges and
the same single destination.

## Hardening checklist

- [ ] The token is supplied by a secrets manager into `config.toml` or the environment —
      never committed to a shared `config.toml`, and never under `[shell_environment_policy]`
- [ ] `~/.codex/config.toml` is readable only by the developer's account
- [ ] `REVA_HOST` set explicitly for your tenant; the built-in default is `api.reva.ai`
- [ ] Hooks are pre-trusted through managed `requirements.toml`, or every developer has
      confirmed them with `/hooks` — and re-confirms after any `hooks.json` change
- [ ] Token rotation has a named owner — the plugin does not detect or warn on expiry, it
      simply passes traffic through for the remainder of each session (401 fails open)
- [ ] Developers on API-key sign-in have `agent_id` / `REVA_AGENT_ID` set, or they are blocked
- [ ] `REVA_DEBUG` off in normal use — it logs decisions and payload detail to stderr and to
      a `debug.log` that persists across sessions
- [ ] Your team has been told what this transmits, per "What it sends, and what it keeps"
- [ ] The Reva tenant's retention policy for prompt, command and file content has been reviewed
- [ ] The clone is checked out at a pinned tag rather than tracking a branch

## Supported versions

Security fixes are issued for the latest minor release. Pin a tag rather than tracking a
branch, and rebuild with `npm install` after updating.