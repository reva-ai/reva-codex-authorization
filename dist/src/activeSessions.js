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
exports.markSessionActive = markSessionActive;
exports.getActiveSessions = getActiveSessions;
exports.getActiveSessionCount = getActiveSessionCount;
exports.getSessionEntry = getSessionEntry;
exports.markSessionInactive = markSessionInactive;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const pluginPaths_1 = require("./pluginPaths");
const ACTIVE_TTL_MS = 10 * 60 * 1000; // no activity for 10 minutes => treated as gone
function cacheDir(dataDir) {
    return (0, pluginPaths_1.stateDir)('active-sessions', dataDir);
}
function cacheFile(agentId, dataDir) {
    return path.join(cacheDir(dataDir), `${(0, pluginPaths_1.safeFileName)(agentId)}.json`);
}
function loadState(agentId, dataDir) {
    try {
        const raw = fs.readFileSync(cacheFile(agentId, dataDir), 'utf8');
        const parsed = JSON.parse(raw);
        return { sessions: parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {} };
    }
    catch {
        return { sessions: {} };
    }
}
function saveState(agentId, state, dataDir) {
    try {
        fs.mkdirSync(cacheDir(dataDir), { recursive: true });
        fs.writeFileSync(cacheFile(agentId, dataDir), JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort — the next call just tries again
    }
}
// Drops any entry not seen within ACTIVE_TTL_MS — called on every write so
// the file can't accumulate sessions that closed hours/days ago.
function pruneStale(state) {
    const now = Date.now();
    const sessions = {};
    for (const [sessionId, entry] of Object.entries(state.sessions)) {
        if (now - entry.lastSeen < ACTIVE_TTL_MS) {
            sessions[sessionId] = entry;
        }
    }
    return { sessions };
}
// Registers (or refreshes) this session as active, and returns the entry
// just written — callers use this directly for the current session's own
// context fields (sessionId/sessionEntryPoint/sessionLastSeen), no separate
// read needed. Returns undefined for an empty/missing sessionId — nothing
// honest to record (avoids a literal "undefined" key) or report.
function markSessionActive(agentId, sessionId, entrypoint, dataDir) {
    if (!sessionId)
        return undefined;
    const state = pruneStale(loadState(agentId, dataDir));
    const entry = { entrypoint, lastSeen: Date.now() };
    state.sessions[sessionId] = entry;
    saveState(agentId, state, dataDir);
    return { sessionId, ...entry };
}
// Every session currently considered active for this Agent (this machine),
// including the caller's own — so 1 means only this session is active, 2+
// means at least one other tab/window is also running right now.
function getActiveSessions(agentId, dataDir) {
    const state = pruneStale(loadState(agentId, dataDir));
    return Object.entries(state.sessions).map(([sessionId, entry]) => ({ sessionId, ...entry }));
}
function getActiveSessionCount(agentId, dataDir) {
    return getActiveSessions(agentId, dataDir).length;
}
// Read-only lookup of one session's own entry, without refreshing it —
// used by PostToolUse, where PreToolUse already refreshed lastSeen moments
// earlier in the same tool-call cycle.
function getSessionEntry(agentId, sessionId, dataDir) {
    return getActiveSessions(agentId, dataDir).find((s) => s.sessionId === sessionId);
}
// Explicit removal, called from SessionEnd (sessionEnd.ts) when it fires —
// the one non-TTL way an entry leaves this file. SessionEnd isn't
// guaranteed to fire on an abrupt termination (killed process, closed
// terminal) — the TTL above stays as the fallback for exactly that gap;
// this is just the fast path for a graceful one, so a session doesn't linger
// as "active" for up to ACTIVE_TTL_MS after it's actually gone.
function markSessionInactive(agentId, sessionId, dataDir) {
    if (!sessionId)
        return;
    const state = pruneStale(loadState(agentId, dataDir));
    if (sessionId in state.sessions) {
        delete state.sessions[sessionId];
        saveState(agentId, state, dataDir);
    }
}
