"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_TYPE = void 0;
exports.resolveEntityTypeIds = resolveEntityTypeIds;
exports.upsertUser = upsertUser;
exports.upsertAgent = upsertAgent;
exports.ingestMcpServersFromConfig = ingestMcpServersFromConfig;
exports.isMcpDiscoveryDue = isMcpDiscoveryDue;
exports.recordMcpDiscoveryTriggered = recordMcpDiscoveryTriggered;
exports.isMcpServerKnown = isMcpServerKnown;
exports.isMcpInvokeIngestDue = isMcpInvokeIngestDue;
exports.recordMcpInvokeIngestTriggered = recordMcpInvokeIngestTriggered;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const mcpConfig_1 = require("./mcpConfig");
const pluginPaths_1 = require("./pluginPaths");
function cacheDir(dataDir) {
    return (0, pluginPaths_1.stateDir)('entity-types', dataDir);
}
// Shared across every concurrently-open Codex session on the machine.
// Worst case on a cold-cache race between two sessions is a harmless
// duplicate GET/POST, not corruption.
function cacheFile(dataDir) {
    return path.join(cacheDir(dataDir), 'catalog.json');
}
function loadIngestionCache(dataDir) {
    try {
        return JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
    }
    catch {
        return undefined;
    }
}
function saveIngestionCache(entry, dataDir) {
    try {
        fs.mkdirSync(cacheDir(dataDir), { recursive: true });
        // Merge onto whatever's already cached (entity-type ids and ingested
        // signatures are written independently, at different points in
        // sessionStart.ts's flow) rather than clobbering one with the other.
        const existing = loadIngestionCache(dataDir) || {};
        fs.writeFileSync(cacheFile(dataDir), JSON.stringify({ ...existing, ...entry }), 'utf8');
    }
    catch {
        // best effort — a fetch/ingest just happens again next session
    }
}
// Confirmed live: a cached entityTypeId that no longer resolves to a real
// entity type (a policy-store/tenant migration reassigns these ids
// server-side) fails with this specific 404 body containing
// "Entity type not found". resolveEntityTypeIds' own cache has no TTL and
// only ever re-fetches when a value is MISSING, never when a present value
// has gone stale — so without this, every ingestion call keeps failing
// against dead ids indefinitely.
function isEntityTypeNotFoundError(err) {
    return err instanceof Error && err.message.includes('Entity type not found');
}
// Clears the WHOLE local ingestion cache, not just the three entity-type
// ids — a migration leaves knownMcpServerNames equally stale.
function invalidateStaleIngestionCache(dataDir) {
    saveIngestionCache({
        userEntityTypeId: undefined,
        agentEntityTypeId: undefined,
        mcpServerEntityTypeId: undefined,
        knownMcpServerNames: undefined,
        lastMcpDiscoveryTriggeredAt: undefined,
        lastMcpInvokeIngestAt: undefined,
    }, dataDir);
}
// NO "already ingested" CACHE, deliberately.
//
// An earlier version of this file kept a local signature of the last
// successful ingest and skipped the call when nothing had changed. That is
// removed, and must not come back: it is the one thing that breaks
// self-healing. Delete an entity on the Reva side and a cached "I already did
// this" flag means the plugin never notices — it just keeps skipping. With a
// live GET every session, the very next session sees it missing and recreates
// it, with no special handling at all.
//
// We hit exactly this failure live: a catalog cached from the mock server
// made SessionStart skip ingestion entirely against the real store, and the
// RTG answered USER_NOT_FOUND until the cache file was deleted by hand.
//
// The entity-type-id catalog below is the one exception that IS safe to cache
// indefinitely — it is a near-immutable lookup table, not mutable state on
// the far side of a network call.
async function ingestionFetch(cfg, url, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
                ...(cfg.policyStoreId ? { policyStoreId: cfg.policyStoreId } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ingestion API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return await res.json().catch(() => undefined);
    }
    finally {
        clearTimeout(timer);
    }
}
// Existence check for the GET-then-branch upsert.
//
// Two things here are confirmed-by-being-bitten rather than assumed:
//   - Some backends answer an unresolvable id with 400 rather than a clean
//     404. BOTH mean "not found"; handling only one silently turns a
//     creatable entity into a permanent no-op.
//   - A network failure, 5xx or timeout is NOT "not found". It is unknown, and
//     the safe reading is "assume it might already exist": a wrong POST risks
//     a duplicate or conflicting create, while a wrong assume-exists costs at
//     most one skipped update that the next session retries.
async function getEntityState(cfg, entityTypeId, entityId) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
                ...(cfg.policyStoreId ? { policyStoreId: cfg.policyStoreId } : {}),
            },
            signal: controller.signal,
        });
        if (res.status === 200)
            return 'found';
        if (res.status === 404 || res.status === 400)
            return 'not-found';
        return 'inconclusive';
    }
    catch {
        return 'inconclusive';
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchEntityTypes(cfg) {
    const raw = await ingestionFetch(cfg, `${cfg.ingestionUrl}/policy-store/entity-types`, 'GET');
    return Array.isArray(raw) ? raw : [];
}
// Resolves the entity-type ids ingestion calls need to pass as
// `entityTypeId`, caching them so a normal session start doesn't cost a
// network round-trip once they're known. Falls back to whatever was already
// cached if a fresh fetch fails.
async function resolveEntityTypeIds(cfg, dataDir, forceRefresh = false) {
    const cached = loadIngestionCache(dataDir);
    // All three must be resolved for the cache to count as fresh — a partial
    // result keeps retrying on future sessions instead of getting stuck on the
    // same gap forever.
    //
    // forceRefresh (sessionStart.ts, once per session) skips trusting the
    // cache even when it's "complete" — plain and simple proactive refresh,
    // replacing whatever's cached, rather than only reacting after something
    // has already failed against a stale id (see withEntityTypeRetry for that
    // reactive half).
    if (!forceRefresh && cached?.userEntityTypeId && cached?.agentEntityTypeId && cached?.mcpServerEntityTypeId) {
        return cached;
    }
    try {
        const types = await fetchEntityTypes(cfg);
        // Matched by name alone — confirmed there's exactly one entity type per
        // name in this catalog (no cross-schema duplicates). Warn (not fail) if
        // that assumption is ever violated, so a silent misresolution at least
        // leaves a trace under REVA_DEBUG=1.
        for (const name of ['User', 'Agent', 'MCPServer']) {
            const matches = types.filter((t) => t.name === name);
            if (matches.length > 1) {
                (0, debug_1.debugLog)(`resolveEntityTypeIds: multiple entity types named "${name}" — using the first (id=${matches[0].id})`);
            }
        }
        const entry = {
            userEntityTypeId: types.find((t) => t.name === 'User')?.id,
            agentEntityTypeId: types.find((t) => t.name === 'Agent')?.id,
            mcpServerEntityTypeId: types.find((t) => t.name === 'MCPServer')?.id,
        };
        // A freshly-fetched id that DIFFERS from the cached one is a
        // policy-store/tenant migration. Everything derived from the old ids —
        // above all knownMcpServerNames — is now meaningless and has to go.
        const migrated = [
            ['userEntityTypeId', entry.userEntityTypeId],
            ['agentEntityTypeId', entry.agentEntityTypeId],
            ['mcpServerEntityTypeId', entry.mcpServerEntityTypeId],
        ].filter(([field, fresh]) => cached?.[field] && fresh && cached[field] !== fresh);
        if (migrated.length > 0) {
            (0, debug_1.debugLog)(`resolveEntityTypeIds: entity-type ids changed (${migrated
                .map(([field, fresh]) => `${field} ${cached?.[field]} -> ${fresh}`)
                .join('; ')}) — clearing everything derived from the old store`);
            entry.knownMcpServerNames = undefined;
            entry.lastMcpDiscoveryTriggeredAt = undefined;
            entry.lastMcpInvokeIngestAt = undefined;
        }
        saveIngestionCache(entry, dataDir);
        return entry;
    }
    catch {
        return cached || {};
    }
}
// Wraps an ingestion call that depends on a possibly-stale cached
// entityTypeId: on the specific "Entity type not found" failure, invalidates
// the whole local ingestion cache and retries ONCE with a freshly-resolved
// id. Any other failure, or a retry that also fails, is re-thrown.
async function withEntityTypeRetry(cfg, dataDir, entityTypeId, idField, attempt) {
    try {
        return await attempt(entityTypeId);
    }
    catch (err) {
        if (!isEntityTypeNotFoundError(err))
            throw err;
        invalidateStaleIngestionCache(dataDir);
        const fresh = await resolveEntityTypeIds(cfg, dataDir);
        const freshId = fresh[idField];
        if (!freshId || freshId === entityTypeId)
            throw err;
        return await attempt(freshId);
    }
}
async function postEntity(cfg, entityTypeId, entityId, attributes) {
    const url = `${cfg.ingestionUrl}/entity?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'POST', { entityId, attributes, parents: [], children: [] });
}
// Adds / updates one attribute value. For Sets this is ADD (accumulate);
// for scalar Agent.agentType it is the same wire shape — the only confirmed
// write-an-attribute path for an entity that already exists.
async function addAttributeValue(cfg, entityTypeId, entityId, attribute) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'PATCH', { attributeValue: attribute, op: 'ADD', path: 'ATTRIBUTE' });
}
// "Codex" is a constant, not detected — this plugin only ever runs inside
// Codex, loaded exclusively through Codex's own plugin/hook system, so
// there's no real signal to detect "actually running under some other
// coding agent" from inside this codebase: another host can't load this
// plugin in the first place. Exported since context.ts also sends this as
// context.agentType on every evaluation request, not just ingestion's
// Agent.agentType.
exports.AGENT_TYPE = 'Codex';
async function upsertUser(cfg, userEntityTypeId, userEmail, machineId, accountId, dataDir) {
    const state = await getEntityState(cfg, userEntityTypeId, userEmail);
    if (state === 'not-found') {
        // One POST carrying everything, Sets included. There is nothing to
        // accumulate onto yet on a brand-new entity, so a follow-up PATCH would
        // be pure redundancy.
        await withEntityTypeRetry(cfg, dataDir, userEntityTypeId, 'userEntityTypeId', (id) => postEntity(cfg, id, userEmail, [
            { name: 'active', value: 'false' },
            { name: 'registeredMachineIds', value: machineId },
            { name: 'agents', value: accountId },
        ])).catch((err) => (0, debug_1.debugLog)(`upsertUser: POST failed — ${err}`));
        return;
    }
    // 'found' or 'inconclusive' — both take the assume-exists branch. Only the
    // accumulating Sets are updated; `active` is left alone forever.
    await withEntityTypeRetry(cfg, dataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'registeredMachineIds', value: machineId })).catch((err) => (0, debug_1.debugLog)(`upsertUser: registeredMachineIds PATCH failed — ${err}`));
    await withEntityTypeRetry(cfg, dataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'agents', value: accountId })).catch((err) => (0, debug_1.debugLog)(`upsertUser: agents PATCH failed — ${err}`));
}
// GET-then-branch upsert for the Agent — the ACCOUNT, not the machine.
//
// `user` is create-only: it records whoever first appears on this account (on a
// shared workspace account, the first member to start a session).
// `agentType` is scalar, per the platform's own Agent schema. Agent id is
// the account id, and from this plugin's perspective that account always
// talks to Reva through exactly one tool (this one), so there is nothing to
// accumulate: agentType is always AGENT_TYPE ("Codex").
// operatingSystems / models remain optional Sets that accumulate when the
// schema declares them (schema may reject; each PATCH is wrapped separately).
async function upsertAgent(cfg, agentEntityTypeId, accountId, userEmail, model, dataDir) {
    const state = await getEntityState(cfg, agentEntityTypeId, accountId);
    if (state === 'not-found') {
        await withEntityTypeRetry(cfg, dataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => postEntity(cfg, id, accountId, [
            { name: 'user', value: userEmail },
            { name: 'agentType', value: exports.AGENT_TYPE },
            { name: 'operatingSystems', value: (0, deviceId_1.osFamily)() },
            // Only when the payload actually carried one — never a placeholder.
            ...(model ? [{ name: 'models', value: model }] : []),
        ])).catch((err) => (0, debug_1.debugLog)(`upsertAgent: POST failed — ${err}`));
        return;
    }
    // agentType first (scalar, shared with Claude), then each optional Set on
    // its own PATCH so a schema that declares one but not another still records
    // what it can.
    await withEntityTypeRetry(cfg, dataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, accountId, { name: 'agentType', value: exports.AGENT_TYPE })).catch((err) => (0, debug_1.debugLog)(`upsertAgent: agentType PATCH failed — ${err}`));
    await withEntityTypeRetry(cfg, dataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, accountId, { name: 'operatingSystems', value: (0, deviceId_1.osFamily)() })).catch((err) => (0, debug_1.debugLog)(`upsertAgent: operatingSystems PATCH failed (schema may not declare it) — ${err}`));
    if (model) {
        await withEntityTypeRetry(cfg, dataDir, agentEntityTypeId, 'agentEntityTypeId', (id) => addAttributeValue(cfg, id, accountId, { name: 'models', value: model })).catch((err) => (0, debug_1.debugLog)(`upsertAgent: models PATCH failed (schema may not declare it) — ${err}`));
    }
}
// Best-effort, partial: Codex declares MCP servers as [mcp_servers.<name>]
// tables in config.toml, where a remote server has a `url` and a stdio
// server has only `command`/`args`. ONLY a url-bearing entry is ingested at
// all now, period — not PATCHed onto registeredMcpServers, not POSTed as a
// MCPServer entity. Per explicit instruction: an entry with no url (a stdio
// server, or one not yet in config.toml) is never ingested — "configured on
// this machine" is no longer enough on its own; RTG must be able to name a
// real entity, with a real baseUrl, or this plugin says nothing about it at
// all. The authorization side matches: a tool call on one of these servers
// is never sent to RTG either (see mapping.ts's skipReason and
// authorize.ts/authorizePost.ts). A missing config.toml (the common case)
// is expected, not an error worth logging.
//
// There is no CLI poll here — Codex's config.toml IS the source of record,
// so reading it costs one local file read. Mid-session rechecks (when a
// server is added after SessionStart) are handled by spawning a detached
// ingest child on a ~15-minute UserPromptSubmit throttle — see
// mcpIngestionTrigger.ts / isMcpDiscoveryDue.
//
// userEntityTypeId/userEmail are optional and trailing (rather than
// reordering the existing positional params) so every pre-existing call
// site — including every test that doesn't care about this — keeps working
// unchanged. When both are given, every genuinely NEW url-bearing server
// name this read finds is also PATCH-ADDed onto the User entity as
// registeredMcpServers — same accumulating-Set pattern as
// registeredMachineIds/agents in upsertUser() above — independently of
// whether its own MCPServer POST (below) also succeeds.
//
// Known-tracking: a name is marked known only after its User-side PATCH
// (when attempted) and its MCPServer POST both succeed — never on an
// unconfirmed or failed attempt. A failed PATCH used to permanently hide
// real gaps. A no-url entry costs nothing either way — it's filtered out
// below before any network call would have been considered, so there's
// nothing to avoid repeating by tracking it as known.
//
// extraServers lets ingest-on-invoke merge a server that no config file
// mentions (already slugged by authorize.ts) into this pass — in practice
// this will always be a no-url entry (that's the only kind authorize.ts's
// ingest-on-invoke ever supplies), so it is filtered out the same as any
// other no-url entry.
async function ingestMcpServersFromConfig(cfg, mcpServerEntityTypeId, configPath, dataDir, userEntityTypeId, userEmail, extraServers = []) {
    const cached = loadIngestionCache(dataDir);
    const known = new Set(cached?.knownMcpServerNames || []);
    const allServers = [...(0, mcpConfig_1.readAllMcpServers)(configPath)];
    for (const extra of extraServers) {
        if (!extra.name || allServers.some((s) => s.name === extra.name))
            continue;
        allServers.push({ name: extra.name, url: extra.url });
    }
    const servers = allServers.filter((server) => Boolean(server.url) && !known.has(server.name));
    for (const server of servers) {
        // Whether registeredMcpServers is settled for this name: true if there
        // was nothing to attempt at all (no userEntityTypeId/userEmail), false
        // until a PATCH is confirmed successful.
        let userSideSettled = !(userEntityTypeId && userEmail);
        if (userEntityTypeId && userEmail) {
            try {
                await withEntityTypeRetry(cfg, dataDir, userEntityTypeId, 'userEntityTypeId', (id) => addAttributeValue(cfg, id, userEmail, { name: 'registeredMcpServers', value: server.name }));
                userSideSettled = true;
            }
            catch (err) {
                (0, debug_1.debugLog)(`ingestMcpServersFromConfig: PATCH registeredMcpServers for "${server.name}" failed — ${err}`);
            }
        }
        try {
            await withEntityTypeRetry(cfg, dataDir, mcpServerEntityTypeId, 'mcpServerEntityTypeId', (id) => postEntity(cfg, id, server.name, [
                { name: 'description', value: `MCP server "${server.name}"` },
                { name: 'transport', value: 'http' },
                { name: 'baseUrl', value: server.url },
                { name: 'connectionType', value: 'remote' },
            ]));
            // Known only if BOTH halves landed.
            if (userSideSettled)
                known.add(server.name);
        }
        catch (err) {
            (0, debug_1.debugLog)(`ingestMcpServersFromConfig: ingest "${server.name}" failed — will retry next session — ${err}`);
        }
    }
    saveIngestionCache({ knownMcpServerNames: [...known] }, dataDir);
}
const MCP_DISCOVERY_RECHECK_INTERVAL_MS = 15 * 60 * 1000;
function isMcpDiscoveryDue(dataDir) {
    const cached = loadIngestionCache(dataDir);
    return Date.now() - (cached?.lastMcpDiscoveryTriggeredAt ?? 0) >= MCP_DISCOVERY_RECHECK_INTERVAL_MS;
}
function recordMcpDiscoveryTriggered(dataDir) {
    saveIngestionCache({ lastMcpDiscoveryTriggeredAt: Date.now() }, dataDir);
}
// Invoke-time ingestion (see authorize.ts). Short window, because this only
// fires for a server that ISN'T already in knownMcpServerNames — the common
// case costs one Set lookup and nothing else. The window exists purely so a
// burst of calls to the same still-unknown server can't each spawn their own
// overlapping child while the first one is still running.
const MCP_INVOKE_INGEST_INTERVAL_MS = 60 * 1000;
function isMcpServerKnown(name, dataDir) {
    const cached = loadIngestionCache(dataDir);
    return (cached?.knownMcpServerNames || []).includes(name);
}
function isMcpInvokeIngestDue(dataDir) {
    const cached = loadIngestionCache(dataDir);
    return Date.now() - (cached?.lastMcpInvokeIngestAt ?? 0) >= MCP_INVOKE_INGEST_INTERVAL_MS;
}
function recordMcpInvokeIngestTriggered(dataDir) {
    saveIngestionCache({ lastMcpInvokeIngestAt: Date.now() }, dataDir);
}
