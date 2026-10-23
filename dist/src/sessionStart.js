"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const identity_1 = require("./identity");
const ingestionClient_1 = require("./ingestionClient");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const pluginPaths_1 = require("./pluginPaths");
const stdin_1 = require("./stdin");
// SessionStart cannot block. Its generated output schema
// (codex-rs/hooks/schema/generated/session-start.command.output.schema.json,
// rust-v0.151.0) has no `decision` or `reason` field at all — only
// continue/stopReason/suppressOutput/systemMessage and
// hookSpecificOutput.additionalContext. So unlike the three authorizing
// entrypoints, nothing in this file may ever throw out of main(), every
// ingestion attempt is individually wrapped so one failure can't stop the
// next, and it ALWAYS exits 0 with empty stdout.
//
// Do not copy authorize.ts's fail-closed `main().catch(denyAndExit)` onto
// this file. Exiting 2 here would be a blocking signal from a hook that has
// no business blocking anything.
//
// Both User and Agent go through a live GET-then-branch upsert every
// session — no local "already ingested" cache. That is what makes this
// self-healing: an entity deleted on the Reva side is recreated on the very
// next session with no special handling.
//
// User and Agent run concurrently (different entities, no shared writes).
// MCP server ingestion is deliberately NOT part of this wait: it's spawned
// below as a fully detached, unref'd child.
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const dataDir = (0, pluginPaths_1.resolveDataDir)();
    // Independent of Reva config being valid at all — this is purely local
    // bookkeeping (which session_ids are active on this machine right now),
    // resolved the same way loadConfig() would derive agentId, but without
    // needing the rest of loadConfig() to succeed first.
    //
    // REVA_AGENT_ID must be honored here even though loadConfig() is not
    // called, because config.ts honors it everywhere else. Reading it in one
    // place and not the other splits the active-sessions file in two — this
    // hook writing to the hardware id while every PreToolUse reads the
    // override — so activeSessionCount would silently under-report. (Found by
    // a test here.)
    try {
        // Same account-scoped resolution loadConfig() uses, but without needing
        // the rest of loadConfig() to succeed first. Unresolvable simply means no
        // local session bookkeeping this session — never a thrown error, because
        // nothing in this file may escape main().
        const agentId = process.env.REVA_AGENT_ID?.trim() || (0, identity_1.readCodexAccountId)();
        if (agentId) {
            (0, activeSessions_1.markSessionActive)(agentId, input.session_id, (0, identity_1.resolveSessionEntrypoint)(), dataDir);
        }
        else {
            (0, debug_1.debugLog)('sessionStart: no account id resolved — skipping active-session bookkeeping');
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
    }
    try {
        // loadConfig() throws if REVA_AUTH_TOKEN isn't visible to this hook
        // process — expected and common here, since a session can start
        // perfectly well with nothing configured yet. Caught below like any
        // other best-effort ingestion failure rather than treated specially.
        //
        // Under REVA_DEBUG=1 this is also the earliest, cheapest place to learn
        // that the token isn't reaching hooks at all: the message names the
        // cause directly (see config.ts assertTokenVisible).
        const cfg = (0, config_1.loadConfig)();
        // Forced fresh fetch, replacing whatever's cached, once per session —
        // rather than only reacting after something has already failed against
        // a stale cached id. Done BEFORE spawning MCP ingestion below so that
        // detached child reads the freshly-replaced cache, not whatever was
        // cached before this session started.
        const { userEntityTypeId, agentEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, dataDir, true);
        // Started before the blocking work below so its own latency overlaps
        // with it instead of stacking on top of it. Unconditional, every
        // session — but still records the trigger time so a throttled
        // UserPromptSubmit recheck doesn't immediately re-trigger.
        (0, mcpIngestionTrigger_1.spawnMcpIngestion)(input.cwd || process.cwd(), dataDir);
        (0, ingestionClient_1.recordMcpDiscoveryTriggered)(dataDir);
        const userEmail = (0, identity_1.resolveUserEmail)();
        try {
            // The MACHINE id — a different concept from cfg.agentId, which is the
            // ACCOUNT. This one exists solely to accumulate into
            // User.registeredMachineIds.
            const machineId = (0, deviceId_1.resolveMachineId)(dataDir);
            const tasks = [];
            if (!userEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped User ingestion — could not resolve entity type id');
            }
            else {
                tasks.push((0, ingestionClient_1.upsertUser)(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId, dataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: upsert User failed — ${err}`)));
            }
            if (!agentEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped Agent ingestion — could not resolve entity type id');
            }
            else {
                // userEmail rides as an ATTRIBUTE on the Agent (a reference back to
                // whose account this is) — separate from, and in addition to, the
                // direct User upsert above. Together with User.agents this makes the
                // link bidirectional, each direction written independently.
                tasks.push((0, ingestionClient_1.upsertAgent)(cfg, agentEntityTypeId, cfg.agentId, userEmail, input.model, dataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: upsert Agent failed — ${err}`)));
            }
            await Promise.all(tasks);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}
main().catch(() => process.exit(0));
