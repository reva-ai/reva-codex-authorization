# Troubleshooting

Start here:

```bash
REVA_DEBUG=1 codex
```

or, without touching the environment, add `debug = true` under `[reva]` in
`~/.codex/config.toml`.

Every hook then logs the action it mapped, the resources it found, the RTG's raw response
and the decision, to stderr — and appends the same lines, timestamped, to `debug.log` in
the plugin's data directory:


## Every action is blocked

The plugin fails closed on **misconfiguration** and on **Reva being unreachable**, as well
as on a real policy deny. In order of likelihood:

**No token.** With debug on you will see
`Reva governance is not configured — missing: REVA_AUTH_TOKEN`, preceded by a line saying
what each source held (`absent`, `present but EMPTY`, or `set (N chars)`) — never the value
itself. `present but EMPTY` means something tried to supply the token and handed over
nothing. Note that a token under `[shell_environment_policy]` is invisible to hooks — see
[CONFIGURATION.md](CONFIGURATION.md#the-config-file).

**No account id.** You will see
`Reva governance cannot resolve a stable account id for this Codex install`. This affects
everyone signed in to Codex with an API key, and installs that keep credentials in the OS
keyring rather than `auth.json`. Set `agent_id` under `[reva]` — see
[CONFIGURATION.md](CONFIGURATION.md#if-you-sign-in-to-codex-with-an-api-key).

**Wrong host, or Reva unreachable.** Every call fails, and failing closed blocks every
action. Debug shows `Reva RTG is unavailable` or `timed out`. Remember the host comes from
`REVA_HOST` first, then `config.toml`, then `api.reva.ai`.

**Your policy genuinely denies it.** The reason reads
`Blocked by your organization's security policy.` — deliberately the same text for every
policy deny; the RTG's own policy text is not shown. Check the decision log in your Reva
console.


## Nothing appears to be governed

The plugin fails **closed** when Reva cannot answer, so a Reva outage shows up as
everything being blocked, not as ungoverned work. If actions are passing through with no
trace in your Reva decision log, check in this order:

1. **Is `node` on your `PATH`?** Every hook shells out to it. Run `node -v` in the same
   shell Codex launched from.
2. **Is the host right?** REVA_HOST defaults to api.reva.ai. If your tenant is elsewhere, every call fails — and, failing closed, 
    every action is blocked.
3. **Is the token still valid?** A 401 fails open by design and latches that session open
   — the RTG is not called again until a new session starts. The plugin does not warn on
   expiry; it simply stops governing for the rest of that session. With debug on you will
   see `Reva authorization unavailable (…) — failing open for this request`, and then
   `RTG not called — circuit open for this session` on every later call. Fix the token and
   start a new session. This is the failure mode worth monitoring.
4. **Did you start a new session?** Code and environment variables are picked up at
   session start; an older installed copy keeps running its old code until then.

## dist/src/...js not found
The hooks execute compiled JavaScript from dist/, which is committed. If it is missing, 
you have a partial checkout or a modified install:

run:
npm ci && npm run build

## Codex stalls on a tool call

An evaluation call can take up to `REVA_PDP_TIMEOUT_MS` (default 25 s) before the plugin
gives up and blocks the action. A call touching several resources evaluates them in
parallel, so it normally costs about one round trip. The hooks themselves are capped by
`hooks/hooks.json`: 60 s for `PreToolUse` and `PostToolUse`, 45 s for `UserPromptSubmit`.

If calls are routinely slow, lower `REVA_PDP_TIMEOUT_MS` — you are trading a longer stall
for a sooner block on a slow link.

## Session start is slow
Session-start ingestion is best-effort and capped separately at REVA_INGESTION_TIMEOUT_MS (default 5 s). 
It never blocks a session from starting; a failure is logged under REVA_DEBUG=1 and otherwise ignored.
On a brand-new install there can be a brief window before you are fully provisioned in Reva's directory, 
during which policies referencing you may not match as expected.

## A file outside a repository is denied unexpectedly
Resource ids are repository-relative — my-repo/src/index.ts — so one policy works on every machine. 
When the file is not inside a git repository, or lies outside the repository root, the plugin falls back to the absolute path. 
A policy written against a repo-relative pattern will not match that, so the action may be denied by a catch-all rule.

## MCP servers are not showing up in Reva

Servers are read from `[mcp_servers.<name>]` tables in `$CODEX_HOME/config.toml`, and only
those with a `url` — remote servers — are registered. A stdio server has no URL, and the
plugin will not invent one.

The reader is deliberately narrow: an entry written as an inline table, or anything else
it does not recognise, is skipped silently rather than mis-registered. Write each server as
its own `[mcp_servers.<name>]` table with a plain `url = "..."` line.

A server whose tool is invoked but which does not appear in `config.toml` is queued for
registration at that moment.

Registration is separate from enforcement: **MCP tool calls are evaluated as `invokeTool`
whether or not the server has been registered.**

## Known limitations

- **Reads and searches count as shell commands.** Codex has no read or search tool, so
  these arrive as `executeBash`, not `read`, `glob` or `grep`. 
- **Shell command targeting is best-effort, not a full shell parser.** Common commands
  resolve correctly; variables and computed paths fall back to a broader resource. A
  command touching more than 10 paths is blocked and must be split.
- **Files written through the shell count as `executeBash`.** Only edits made with
  `apply_patch` count as `write` or `edit`.


## Still stuck

Open an issue in this repository's tracker
//change(`gitlab.com/reva.ai/pep/plugins/codex`) with your `debug.log`. **Redact the transmitted
content first** — debug output includes prompt, command and patch text.

For anything security-sensitive, email **info@reva.ai** with "SECURITY" in the subject
rather than opening a public issue.
