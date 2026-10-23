"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MISSING_TOKEN_MESSAGE = exports.DEFAULT_HOST = void 0;
exports.urlFromHost = urlFromHost;
exports.assertTokenVisible = assertTokenVisible;
exports.resolveAccountAgentId = resolveAccountAgentId;
exports.loadConfig = loadConfig;
const codexRevaConfig_1 = require("./codexRevaConfig");
const debug_1 = require("./debug");
const identity_1 = require("./identity");
const DEFAULT_TIMEOUT_MS = 25000;
// The path segment itself is Reva's actual API route — fixed by the
// backend, not ours to rename regardless of what we call this internally.
const RTG_PATH = '/pdp/v2/ai/evaluation';
const INGESTION_PATH = '/ingestion/v2';
// REVA_HOST overrides this.
exports.DEFAULT_HOST = 'api.reva.ai';
// Deliberately much shorter than the evaluation timeout — ingestion is
// best-effort with zero user-facing value on failure (see sessionStart.ts),
// so there's no reason to let it stall session startup anywhere near as
// long as an evaluation call, which is actually gating a real action.
const DEFAULT_INGESTION_TIMEOUT_MS = 5000;
// Whether a config value arrived, WITHOUT ever revealing it. "set" vs
// "empty" vs "absent" are three different problems: absent means nobody
// configured it, empty means something tried to supply it and handed over
// nothing, and those need opposite fixes.
function describePresence(value) {
    if (value === undefined)
        return 'absent';
    if (value.length === 0)
        return 'present but EMPTY';
    return `set (${value.length} chars)`;
}
function normalizeHost(raw) {
    return raw.trim().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}
function schemeForHost(host) {
    const h = host.toLowerCase();
    if (h.startsWith('localhost') || h.startsWith('127.0.0.1') || h.startsWith('[::1]')) {
        return 'http';
    }
    return 'https';
}
function urlFromHost(host, path) {
    const normalized = normalizeHost(host);
    return `${schemeForHost(normalized)}://${normalized}${path}`;
}
exports.MISSING_TOKEN_MESSAGE = 'Reva governance is not configured — missing: REVA_AUTH_TOKEN. ' +
    'Put it in ~/.codex/config.toml under [reva] (auth_token = "...") or [reva.env] ' +
    '(REVA_AUTH_TOKEN = "..."), or export REVA_AUTH_TOKEN in the environment of the Codex process. ' +
    'Hooks inherit Codex\'s process environment, captured at session start — restart Codex after ' +
    'changing env vars. Note: [shell_environment_policy] in config.toml does NOT help here; it ' +
    "governs the environment given to the model's shell tool, not to hooks.";
// Codex hands hook processes a snapshot of its OWN process environment,
// taken once at session start. REVA_AUTH_TOKEN in that snapshot still works
// as a fallback; the preferred customer path is ~/.codex/config.toml [reva].
//
// WHY THIS CHECK EXISTS AS ITS OWN FUNCTION, with this comment:
// Codex ALSO has a ShellEnvironmentPolicy whose default excludes strip every
// variable matching *KEY*, *SECRET* or *TOKEN* — and `REVA_AUTH_TOKEN`
// matches *TOKEN*. That policy governs the environment handed to the MODEL's
// shell tool, NOT to hooks; hooks bypass it entirely today. That is a real
// distinction in the Codex source, not a coincidence we can rely on
// forever: if hook execution is ever routed through the same policy, the
// env fallback disappears. Failing here, loudly and specifically, is what
// makes that regression diagnosable in one step instead of ten.
function assertTokenVisible(env) {
    const token = env.REVA_AUTH_TOKEN;
    if (!token || !token.trim()) {
        throw new Error(exports.MISSING_TOKEN_MESSAGE);
    }
    return token;
}
// The Agent entity's id. Mirrors assertTokenVisible's posture exactly: a
// required identity value that cannot be resolved fails loudly and
// immediately with an actionable message, rather than degrading to a
// synthetic stand-in that "just works" until someone notices the directory
// has one Agent per machine instead of one per person.
function resolveAccountAgentId(env = process.env) {
    const accountId = (0, identity_1.readCodexAccountId)(undefined, env);
    if (!accountId) {
        throw new Error(identity_1.MISSING_ACCOUNT_ID_MESSAGE);
    }
    return accountId;
}
// Token/agentId: ~/.codex/config.toml [reva] first, then process env.
// Host: REVA_HOST env, else config.toml host, else DEFAULT_HOST.
// `configPath` is for tests only.
function loadConfig(env = process.env, configPath) {
    const fromFile = (0, codexRevaConfig_1.readCodexRevaConfig)(configPath);
    const host = env.REVA_HOST?.trim() || fromFile.host || exports.DEFAULT_HOST;
    const rtgUrl = urlFromHost(host, RTG_PATH);
    const ingestionUrl = urlFromHost(host, INGESTION_PATH);
    const authorization = fromFile.authToken || env.REVA_AUTH_TOKEN?.trim() || '';
    if (!authorization) {
        // Say WHICH source was consulted and what each one held, never the value
        // itself. This is the only record that exists: the throw below reaches
        // main().catch, which denies and exits, so nothing else in the process
        // ever gets a chance to log.
        (0, debug_1.debugLog)(`loadConfig: no auth token — REVA_AUTH_TOKEN ${describePresence(env.REVA_AUTH_TOKEN)}, ` +
            `fromFile.authToken ${describePresence(fromFile.authToken)}`);
        throw new Error(exports.MISSING_TOKEN_MESSAGE);
    }
    return {
        rtgUrl,
        authorization,
        // ACCOUNT-scoped, not machine-scoped: one ChatGPT account is one Agent
        // across every machine it signs in from. NO FALLBACK — if no account id can be
        // resolved, this throws rather than substituting a machine or random id.
        agentId: fromFile.agentId || env.REVA_AGENT_ID?.trim() || resolveAccountAgentId(env),
        // REVA_PDP_TIMEOUT_MS is a public, documented config variable — its
        // NAME stays exactly as-is regardless of internal renaming, so an
        // existing deployment that already sets it doesn't silently stop
        // working.
        timeoutMs: Number(env.REVA_PDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ingestionUrl,
        ingestionTimeoutMs: Number(env.REVA_INGESTION_TIMEOUT_MS) || DEFAULT_INGESTION_TIMEOUT_MS,
        // Optional. Unset => header omitted => unchanged default request shape.
        // Set it only when the target platform actually requires the store to
        // be named on the request.
        policyStoreId: env.REVA_POLICY_STORE_ID?.trim() || undefined,
        // Opt-in. Unset => context shape is unchanged and schema-safe.
        modelContext: env.REVA_MODEL_CONTEXT === '1' || env.REVA_MODEL_CONTEXT?.toLowerCase() === 'true',
    };
}
