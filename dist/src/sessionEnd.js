"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const debug_1 = require("./debug");
const identity_1 = require("./identity");
const pluginPaths_1 = require("./pluginPaths");
const stdin_1 = require("./stdin");
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const dataDir = (0, pluginPaths_1.resolveDataDir)();
    // Resolved independently of loadConfig() — same reasoning as
    // sessionStart.ts's own active-session tracking: this is local
    // bookkeeping only, so it shouldn't need the auth token (or anything
    // else loadConfig() requires) to succeed first.
    const agentId = process.env.REVA_AGENT_ID?.trim() || (0, identity_1.readCodexAccountId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no Codex account id resolved and REVA_AGENT_ID not set');
    }
    else {
        try {
            (0, activeSessions_1.markSessionInactive)(agentId, input.session_id, dataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
        }
    }
    process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}
main().catch(() => process.exit(0));
