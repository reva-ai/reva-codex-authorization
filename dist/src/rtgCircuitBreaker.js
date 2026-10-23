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
exports.isCircuitOpen = isCircuitOpen;
exports.openCircuit = openCircuit;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
// Files are only ever created when a session actually takes a 401, which is
// rare, so they accumulate slowly. Swept on write anyway rather than growing
// without bound on a long-lived machine.
//
// Deleting one is harmless by construction: a session this old is long dead,
// so its id will never be seen again and the marker cannot affect any
// decision. The window is generous precisely because nothing depends on it —
// it exists to bound growth, not to expire anything.
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// No fallback: only ever writes inside PLUGIN_DATA (via resolveDataDir
// callers), same as every other local state file in this plugin.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'rtg-circuit-breaker') : undefined;
}
function cacheFile(sessionId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir || !sessionId)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
// Open purely by the file existing and parsing. No clock involved.
function isCircuitOpen(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return { open: false };
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            open: true,
            openedAt: state.openedAt,
            triggeredStatus: state.triggeredStatus,
            errorType: state.errorType,
        };
    }
    catch {
        // Absent is the normal case — this session has not seen a 401. Anything
        // else (unreadable, malformed) is treated the same way deliberately: a
        // latch that cannot be read is not evidence to stop calling the RTG, and
        // erring toward MAKING the call is the safer direction for a governance
        // check.
        return { open: false };
    }
}
// Latches this session open. Idempotent by nature — a second 401 in the same
// session just rewrites the same file.
function openCircuit(sessionId, triggeredStatus, errorType, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!dir || !file)
        return;
    const state = { openedAt: Date.now(), triggeredStatus, errorType };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
        sweepStale(dir);
    }
    catch (err) {
        // Consequence is a security one rather than a wrong value: without the
        // latch every later call in this session re-hits an unauthorized RTG and
        // keeps failing open, with nothing recording that it is happening.
        (0, debug_1.debugLog)(`openCircuit: could not persist the latch for this session — every later call will re-hit the RTG (${err?.message || String(err)})`);
    }
}
// Best-effort, never throws: a sweep failing must not stop a latch being set.
function sweepStale(dir) {
    try {
        const cutoff = Date.now() - STALE_AFTER_MS;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json'))
                continue;
            const file = path.join(dir, name);
            try {
                if (fs.statSync(file).mtimeMs < cutoff)
                    fs.rmSync(file, { force: true });
            }
            catch {
                // another process got there first, or it vanished — either is fine
            }
        }
    }
    catch {
        // directory unreadable — the latch above still landed, which is what matters
    }
}
