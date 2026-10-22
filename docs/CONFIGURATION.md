# Configuration

The plugin is configured from two places: a `[reva]` block in Codex's own config file, and
environment variables. One value is required; the rest have working defaults.

## The config file

Codex's config file is `~/.codex/config.toml` (`$CODEX_HOME/config.toml` if you set
`CODEX_HOME`). The plugin reads two tables from it:

```toml
[reva]
auth_token = "<your token>"
# host     = "api.example.reva.ai"
# agent_id = "<stable account id>"    # only for API-key sign-in — see below
# debug    = true
```

or, with environment-variable-style keys:

```toml
[reva.env]
REVA_AUTH_TOKEN = "<your token>"
# REVA_HOST     = "api.example.reva.ai"
# REVA_AGENT_ID = "<stable account id>"
# REVA_DEBUG    = "1"
```

Inside `[reva]`, `authToken` / `agentId` and the `REVA_*` spellings are accepted as aliases.
If both tables set the same value, `[reva.env]` wins.

Only those four keys are read from the file. The timeouts and every other variable below
are environment-only.

**Do not** put the token under `[shell_environment_policy]`. That table governs the
environment Codex hands to the **model's shell tool**, not to hooks, so the plugin never
sees it.

## Precedence

| Value | Order, first match wins |
|---|---|
| Token | `[reva.env]` → `[reva]` → `REVA_AUTH_TOKEN` env |
| Agent id | `[reva.env]` → `[reva]` → `REVA_AGENT_ID` env → your ChatGPT account id |
| Host | `REVA_HOST` env → `[reva.env]` → `[reva]` → `api.reva.ai` |
| Debug | `REVA_DEBUG` env, if truthy → `[reva.env]` / `[reva]` |


## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `REVA_AUTH_TOKEN` | **yes**, unless set in `config.toml` | — | Authenticates every request — RTG evaluation and ingestion. Sent as `X-API-Token`. |
| `REVA_AGENT_ID` | **conditionally** | your ChatGPT account id | The agent's Cedar identity. Resolved automatically from `$CODEX_HOME/auth.json`. **Required when Codex is signed in with an API key** — see below. |
| `REVA_HOST` | no | `api.reva.ai` | Your Reva tenant's API host. |
| `REVA_DEBUG` | no | off | `1` logs each mapping, decision and RTG response to stderr, and appends the same lines, timestamped, to `debug.log` in the plugin's data directory. |
| `REVA_PDP_TIMEOUT_MS` | no | `25000` | Timeout for an evaluation call. On timeout the plugin fails **closed** — the action is blocked. |
| `REVA_INGESTION_TIMEOUT_MS` | no | `5000` | Timeout for each ingestion call. Deliberately much shorter — ingestion is best-effort and never gates an action. |
| `REVA_SESSION_ENTRYPOINT` | no | — | Value reported as `context.sessionEntryPoint` **only when Codex supplies no surface marker of its own** — for example a Homebrew or direct-download CLI. A detected surface always wins. See [SURFACES.md](SURFACES.md). |
| `REVA_MODEL_CONTEXT` | no | off | `1` or `true` adds `model` — Codex's model slug for the session — to every action's Cedar context. **Your schema must declare `model` on every gated action first.** Cedar context is closed, so enabling this early denies everything. |
| `REVA_POLICY_STORE_ID` | no | — | Sent as a `policyStoreId` header on evaluation and ingestion. Provisional and opt-in: Set it only if your platform requires the store named on the request. |
| `REVA_CODEX_AUTH_PATH` | no | `$CODEX_HOME/auth.json` | Overrides where the plugin reads your ChatGPT identity from. Intended for tests.
| `REVA_SESSION_CWD` | no | — | Set by the plugin on its detached MCP-ingestion child. Not intended to be set by hand. |
| `REVA_INVOKED_MCP_SERVER` | no | — | Set by the plugin on that same child, naming the MCP server whose invocation triggered it. Not intended to be set by hand. |


## If you sign in to Codex with an API key

Read this section if you do **not** sign in to Codex with a ChatGPT account.

The plugin derives the agent's identity from the ChatGPT account id
(`chatgpt_user_id`, falling back to `user_id`) inside the `id_token` in
`$CODEX_HOME/auth.json`. 
An API-key sign-in has no such account, and the same is true when
Codex keeps its credentials in the OS keyring instead of `auth.json`. The plugin
deliberately does **not** substitute a machine id or a random value: an invented identity
would be meaningless to a policy, and would split one person into one `Agent` per machine.

The result is that the plugin **fails closed and blocks every action** with:

```
Reva governance cannot resolve a stable account id for this Codex install. ...
Sign in with a ChatGPT account, or set REVA_AGENT_ID explicitly to the account id this
install should report.
```

Set `agent_id` under `[reva]` (or `REVA_AGENT_ID`) to a stable identifier for this agent,
and make sure the matching entity exists in your Reva tenant.

## Hosts and transport

The host accepts a bare name (`api.example.reva.ai`) or one with a scheme, which is
stripped. Trailing slashes are removed. Paths are fixed in code:

- evaluation: `/pdp/v2/ai/evaluation`
- ingestion: `/ingestion/v2`

The scheme is **HTTPS for every host** except `localhost`, `127.0.0.1` and `[::1]`, which
use plain HTTP so a local mock RTG works. This cannot be overridden for a remote host.

Every evaluation request carries `X-API-Token`, `X-API-Origin-App: CODEX`, a W3C
`traceparent`, and `X-Reva-Thread-Id` set to the Codex session id, plus `policyStoreId` when
configured.

## What blocks and what does not

| Condition | Outcome |
|---|---|
| Policy denies (403) | **blocked** |
| Guardrails return `conditional_allow` | **allowed**, with the guardrail's reason passed to Codex as an advisory note |
| Reva unreachable, times out, or errors (5xx, 424, 404, 429, any other 4xx) | **blocked** — fails closed |
| Token rejected (401) | **passes through for the rest of that session** — fails open |
| Payload too large (413) | **passes through** for that request — fails open |
| Token or agent id missing, unreadable hook payload, or any internal error | **blocked, every action** — fails closed |
| A shell command touches more than 10 distinct paths | **blocked**, with a request to split it |
| A patch whose target files cannot be parsed | **blocked** |

A 401 latches only the session that received it: the plugin stops calling the RTG for the
rest of that session, other sessions are unaffected, and a new session always calls again.
It usually means a principal that is not provisioned yet rather than a security failure.
Every other operational failure blocks, so a Reva outage never silently lets work through.

Codex hooks cannot raise an interactive approval prompt — Codex parses
`permissionDecision: "ask"` and then discards it, which would silently allow.It is deliberately not
turned into a block either, which would make one RTG response mean different things on
different agents.

## Policies

Policies are authored and managed in Reva, not here — this plugin only enforces what your
organization has configured.Rules can be scoped to any governed action and to specific resources, from "no shell commands anywhere" to "file writes only inside this repository". 
See your Reva console. 