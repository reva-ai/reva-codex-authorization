# Installing

## Requirements

- **Codex CLI**, with `codex` on your `PATH`. Verified against Codex 0.151.0 and Codex CLI
  0.162.1.
- **Node.js 18 or later**, with `node` on your `PATH`. Every hook runs as a short-lived
  `node` process, so if `node` is not resolvable the plugin cannot run at all.
- A **Reva auth token** for your tenant, and your tenant's **API host** unless you are on
  the default `api.reva.ai`.

No build step is needed. Compiled JavaScript is committed to the repository, and the hooks
run it directly.

## Individual install

```bash
codex plugin marketplace add https://github.com/reva-ai/reva-codex-authorization
codex plugin add reva-security@reva-plugins
```

//Check remove if --config works
**2. Add your token** to `~/.codex/config.toml`:

```toml
[reva]
auth_token = "<your token>"
```
Start a new `codex` session afterwards — configuration is read at session start, not live.

//Check 

If your tenant is not on `api.reva.ai`, pass it at install time too:

//check
```bash
codex plugin install reva-security@reva-plugins \
  --config auth_token=<your token> \
  --config host=api.example.reva.ai
```

`REVA_HOST` in the environment overrides the dialog value — see
[CONFIGURATION.md](CONFIGURATION.md).

## Team rollout

Deploy to everyone in your workspace without each person running a command.

### 1. Admin — deliver the token

Store your Reva workspace token in your organization's secrets manager and expose it to
each machine as the **system** environment variable `REVA_AUTH_TOKEN`. Keep it there, not
in a shared config file, so it stays under your secrets manager's access controls.

If your tenant is not on `api.reva.ai`, set `REVA_HOST` the same way.

### 2. Admin — install the plugin for everyone

In the ChatGPT **Admin Console → Agent Security → configuration defaults**, add:

```toml
[marketplaces.reva-plugins]
source_type = "git"
source = "https://github.com/reva-ai/<repo>.git"  --update
ref = "<release tag>"

[plugins."reva-security@reva-plugins"]
enabled = true
```

Developers get the plugin the next time they start Codex. To roll out a new version,
change `ref`.

### 3. Each developer — approve the hooks once

1. Sign in to Codex with your ChatGPT Business or Enterprise account.
2. Start a Codex session. When Codex asks about the new Reva Security hooks, choose
   **Trust all and continue**.
3. If you skipped that prompt, run `/hooks` and trust the five Reva Security hooks.

//check
## Updating

**Your token.**

- **In `config.toml`**: edit the value. The file is read afresh by every hook call, so the
  next call uses it. If the old token had already been rejected (401) in a running session,
  that session stays ungoverned — start a new one.
- **As an environment variable**: update it at the source — your shell profile or your secrets manager — then quit and relaunch Codex from a shell that has the new value. Hooks inherit the Codex process's environment, which is fixed at launch; starting a new session inside a running Codex is not enough. 

Note that `config.toml` takes priority over the environment for the token, so an old value
left in the file silently wins over a new environment variable.

**The plugin.** Pull the new version and run `npm install` (or `npm run build`) in the
clone. The build re-registers the plugin, so the next new session runs the new code. An
already-running session keeps the code it started with. If the update changed
`hooks/hooks.json`, re-trust the hooks with `/hooks`.


## Uninstalling

```bash
npm run uninstall-plugin
```

This runs `codex plugin remove reva-security@reva-plugins` and
`codex plugin marketplace remove reva-plugins`. 

Then:
- remove the `[reva]` / `[reva.env]` blocks from `~/.codex/config.toml`;