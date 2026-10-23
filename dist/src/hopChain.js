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
exports.startTurnHops = startTurnHops;
exports.loadAgentHops = loadAgentHops;
exports.enqueuePendingSpawnLineage = enqueuePendingSpawnLineage;
exports.resolveSubAgentLineage = resolveSubAgentLineage;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const pluginPaths_1 = require("./pluginPaths");
const EMPTY_STATE = { agentHops: [], pendingSubAgentLineages: [], boundLineages: {} };
function cacheDir(dataDir) {
    return (0, pluginPaths_1.stateDir)('hops', dataDir);
}
function cacheFile(sessionId, dataDir) {
    return path.join(cacheDir(dataDir), `${(0, pluginPaths_1.safeFileName)(sessionId)}.json`);
}
function loadState(sessionId, dataDir) {
    try {
        const raw = fs.readFileSync(cacheFile(sessionId, dataDir), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return EMPTY_STATE;
    }
}
function saveState(sessionId, state, dataDir) {
    try {
        fs.mkdirSync(cacheDir(dataDir), { recursive: true });
        fs.writeFileSync(cacheFile(sessionId, dataDir), JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort — subsequent requests just see an empty chain
    }
}
// Called once per turn, from UserPromptSubmit, right after the invokeAgent
// decision is evaluated. Resets the chain for this session: a new user
// turn starts its own fresh lineage rather than accumulating across the
// whole session, and any subagents from a previous turn no longer apply.
function startTurnHops(sessionId, invokeAgentHop, dataDir) {
    saveState(sessionId, { agentHops: [invokeAgentHop], pendingSubAgentLineages: [], boundLineages: {} }, dataDir);
}
// The lineage for the main session's own tool calls this turn.
function loadAgentHops(sessionId, dataDir) {
    return loadState(sessionId, dataDir).agentHops;
}
// Called from a spawn action's authorization: queues the lineage the new
// subagent should inherit (the spawner's own current lineage, plus this
// spawn) for the next unbound subagent id seen this session.
function enqueuePendingSpawnLineage(sessionId, parentLineage, spawnHop, dataDir) {
    const state = loadState(sessionId, dataDir);
    state.pendingSubAgentLineages.push([...parentLineage, spawnHop]);
    saveState(sessionId, state, dataDir);
}
// Called for every subagent tool call. Returns the subagent's own bound
// lineage if already resolved; otherwise binds the oldest still-pending
// spawn lineage to this subagent id (first subagent tool call this session
// => first pending spawn, in order) and persists the binding for its later
// calls. Returns [] if there's nothing pending (shouldn't normally happen —
// a subagent's own calls always follow its spawn — but keeps this from
// crashing if it does).
function resolveSubAgentLineage(sessionId, subAgentId, dataDir) {
    const state = loadState(sessionId, dataDir);
    const existing = state.boundLineages[subAgentId];
    if (existing)
        return existing;
    const lineage = state.pendingSubAgentLineages.shift();
    if (!lineage)
        return [];
    state.boundLineages[subAgentId] = lineage;
    saveState(sessionId, state, dataDir);
    return lineage;
}
