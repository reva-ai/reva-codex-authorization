# Reva runtime authorization for OpenAI Codex

A Codex plugin that authorizes every governed tool call and every submitted prompt. Codex
calls it before an action runs; it asks Reva's RTG whether the action is allowed, and blocks
it if not — **before it runs**, not logged after the fact.

The same enforcement Reva applies at the API gateway, brought down to the coding-agent layer.

Plugin id: `reva-security`, from the `reva-plugins` marketplace.

- [How it works](#how-it-works)
- [Supported Codex surfaces](#supported-codex-surfaces)
- [What gets governed](#what-gets-governed)
- [What it sends](#what-it-sends)
- [What blocks, and what doesn't](#what-blocks-and-what-doesnt)
- [Install](#install)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)

## How it works

The plugin hooks five points in a Codex session:

| When | What happens |
| --- | --- |
| A session starts or resumes | Registers you, your account and your remote MCP servers with Reva's directory, so policies can reference you by the time you do anything. Never blocks a session from starting. |
| You submit a prompt | Checks whether you're allowed to invoke the coding agent at all this turn. A deny blocks the turn. |
| Before a governed tool call | Checks whether that specific action is allowed, and blocks it if not. |
| After a governed tool call completes | Re-evaluates with the actual result, for policies that care what a command returned. Codex does not fire this for every call, so it is not an audit backstop. |
| A session ends | Removes the session from local active-session tracking. No Reva request. |

Every check is synchronous, before (or immediately after) the action. Codex runs a plugin's
hooks only after you have reviewed and trusted them with `/hooks` — until then nothing is
governed (see [Install](#install)).

## Supported Codex surfaces

Reva authorizes **Codex** in the CLI, the Codex VS Code extension, other integrations that
load Codex plugin hooks, and the Codex **desktop app**. A Git repository is not required.

Enforcement is identical on every surface: the same hooks, the same checks, the same
fail-closed rules. The surface only changes one reported field, `context.sessionEntryPoint`,
which a policy can match on:

| Surface | `sessionEntryPoint` |
| --- | --- |
| Codex desktop app | `Codex Desktop` |
| Codex CLI installed through npm, bun or pnpm | `codex-cli` |
| Anything else — e.g. a standalone CLI binary (Homebrew, direct download) | `unknown`, unless you set `REVA_SESSION_ENTRYPOINT` |

Codex cloud tasks run in OpenAI's environment, not on your machine, so this locally installed
plugin is not involved in them.


## What gets governed

Each Codex tool maps to a named action, so a policy can distinguish "edit a file" from "run an
arbitrary shell command" rather than lumping everything under one permission:

| Codex does this | Governed as |
| --- | --- |
| Runs a shell command | `executeBash` |
| Creates a file (via a patch) | `write` |
| Edits a file (via a patch) | `edit` |
| Deletes or moves a file (via a patch) | `write` |
| Calls an MCP tool | `invokeTool` |
| Spawns a sub-agent | `spawn` |
| Starts a new turn | `invokeAgent` |

**Codex has no dedicated read or search tools.** Reading and searching files happen through
the shell, so they are governed as `executeBash`, not `read`, `glob` or `grep`. 


Resources are identified by a **repository-relative** path — `my-repo/src/index.ts` — so a
policy written once ("only allow this inside `my-repo/src/**`") works on every developer's
machine regardless of where they cloned it. When a file is not inside a git repository, or
lies outside the repository root, the plugin falls back to the absolute path.


## What it sends

This plugin transmits the  **the text of your prompts, your shell commands, whole patches,the contents of
files being written or read and **MCP tool arguments** and the message handed to a spawned sub-agent;
- **tool output**** to your Reva tenant for evaluation.

That is the point — a policy cannot judge an action it cannot see — but it is a real change
to your environment, and anyone rolling this out to a team should read

[SECURITY.md](SECURITY.md#what-it-sends-and-what-it-keeps) first: it lists every field that
leaves the machine and where each comes from.

Local state lives only in the data directory Codex assigns the plugin
(`~/.codex/plugins/data/reva-security-reva-plugins`; `~/.codex-governance` for hooks
registered by hand). Nothing is written to your repositories.

## What blocks, and what doesn't

| Condition | Outcome |
|---|---|
| Policy denies | **blocked** |
| Guardrails return `conditional_allow` | **allowed**, with the guardrail's reason passed to Codex as a note |
| Reva unreachable, times out, or errors (5xx, 424, 404) | **blocked, every action** — fails closed |
| Token rejected (401) | **passes through for the rest of that session** — fails open |
| Payload too large (413) | **passes through** — fails open |
| Reva token or account id missing | **blocked, every action** — fails closed |

Governance holds even through a Reva-side outage: if the RTG is down, erroring, or
unreachable, actions are blocked rather than silently let through. The two exceptions are a
rejected token (401) — which passes through for the rest of that session, since it more often
reflects a principal that isn't provisioned yet than a real security failure — and an oversized
payload (413), which is about that one request, not a sign Reva itself is unavailable. After a
401 the plugin stops calling Reva for that session; other sessions are unaffected, and starting
a new session checks again.

If you sign in to Codex with an **API key** rather than a ChatGPT account, there is no account
id to identify the agent by: set `agent_id` (or `REVA_AGENT_ID`) explicitly, or every action is
blocked.

## Install

Requires **Node.js 18+** and the **Codex CLI**, both on your `PATH` — every hook runs as a
`node` process.

**1. Install the plugin.** From a clone of this repository:

```bash
codex plugin marketplace add https://github.com/reva-ai/reva-codex-authorization.git
codex plugin add reva-security@reva-plugins 
```

**2. Add your token** to `~/.codex/config.toml`:

```toml
[reva]
auth_token = "<your token>"
```

Start a new Codex session trust all and continue.

Team rollout via managed-settings.json, token rotation, and uninstall are in docs/INSTALL.md.


## Documentation

| Document | Read it for |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Requirements, installing the plugin, trusting the hooks with `/hooks`, team rollout, updating your token or the plugin, uninstalling |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | The `[reva]` block in `config.toml`, precedence between the file and the environment, every environment variable, API-key sign-in and `agent_id`, hosts and transport, what blocks, policies |
| [docs/DESKTOP-COMPATIBILITY.md](docs/DESKTOP-COMPATIBILITY.md) | Which Codex surfaces are governed, how `sessionEntryPoint` is detected, writing policies against it, and why cloud tasks are not covered |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Debug logging, nothing being governed, every action being blocked, specific denials,slow calls, MCP registration |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, exactly what leaves the machine, what blocks, what the plugin does not cover, and a hardening checklist for a team rollout |