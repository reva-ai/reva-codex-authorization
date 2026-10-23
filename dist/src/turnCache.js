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
exports.truncatePrompt = truncatePrompt;
exports.loadTurn = loadTurn;
exports.startTurn = startTurn;
exports.loadOrStartTurn = loadOrStartTurn;
exports.directSessionFromTurn = directSessionFromTurn;
exports.conversationFromTurn = conversationFromTurn;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const pluginPaths_1 = require("./pluginPaths");
// Sent as the invokeAgent userQuery and again as context.conversation on
// every tool call in the turn. An RTG 413 fails open for that request, so
// raise this only after confirming the RTG accepts the resulting request
// size.
const MAX_PROMPT_LENGTH = 10000;
function cacheDir(dataDir) {
    return (0, pluginPaths_1.stateDir)('turns', dataDir);
}
function cacheFile(sessionId, dataDir) {
    return path.join(cacheDir(dataDir), `${(0, pluginPaths_1.safeFileName)(sessionId)}.json`);
}
function truncatePrompt(prompt) {
    return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}
function saveTurn(sessionId, entry, dataDir) {
    try {
        fs.mkdirSync(cacheDir(dataDir), { recursive: true });
        fs.writeFileSync(cacheFile(sessionId, dataDir), JSON.stringify(entry), 'utf8');
    }
    catch {
        // best effort — later hooks can reconstruct metadata from what they see
    }
}
function loadTurn(sessionId, dataDir) {
    try {
        const raw = fs.readFileSync(cacheFile(sessionId, dataDir), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
// Call once per turn, from UserPromptSubmit. Records the prompt against
// this turn_id and advances the ordinal, preserving the session's original
// startedAt.
function startTurn(sessionId, turnId, prompt, dataDir) {
    const previous = loadTurn(sessionId, dataDir);
    const observedAt = new Date().toISOString();
    const entry = {
        turnId,
        ...(prompt ? { prompt: truncatePrompt(prompt) } : {}),
        promptTimestamp: observedAt,
        // A repeated UserPromptSubmit for the SAME turn_id must not advance the
        // ordinal — only a genuinely new turn does.
        turn: previous?.turnId === turnId ? previous.turn : (previous?.turn || 0) + 1,
        startedAt: previous?.startedAt || observedAt,
    };
    saveTurn(sessionId, entry, dataDir);
    return entry;
}
// Pre/Post hooks normally follow UserPromptSubmit within the same turn_id.
// If one fires for a turn_id we have no record of, record that first
// observed event as the turn rather than fabricating session metadata.
//
// The stale prompt is deliberately DROPPED when the turn_id differs: it
// belongs to a previous turn, and attaching it as this turn's conversation
// evidence would be fabricating history for the RTG to reason about.
function loadOrStartTurn(sessionId, turnId, dataDir) {
    const existing = loadTurn(sessionId, dataDir);
    if (existing?.turnId === turnId && existing.startedAt && existing.promptTimestamp) {
        return existing;
    }
    return startTurn(sessionId, turnId, undefined, dataDir);
}
function directSessionFromTurn(sessionId, turn) {
    return { id: sessionId, turn: turn.turn, startedAt: turn.startedAt };
}
function conversationFromTurn(turn) {
    if (!turn.prompt?.trim())
        return [];
    return [
        {
            seq: 1,
            role: 'user',
            contentType: 'text/plain',
            content: turn.prompt,
            timestamp: turn.promptTimestamp,
        },
    ];
}
