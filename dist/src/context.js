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
exports.osAttribute = osAttribute;
exports.buildActionContext = buildActionContext;
exports.buildInvokeAgentContext = buildInvokeAgentContext;
exports.buildTransmission = buildTransmission;
exports.serializeToolResponse = serializeToolResponse;
exports.buildToolResponseTransmission = buildToolResponseTransmission;
const nodeOs = __importStar(require("node:os"));
const ingestionClient_1 = require("./ingestionClient");
// Exported (with an injectable platform, defaulting to the real one) so
// tests can cover the mapping directly without mocking node:os — same
// pattern config.ts's loadConfig(env = process.env) uses.
function osAttribute(platform = nodeOs.platform()) {
    return platform === 'win32' ? 'Windows' : 'Linux';
}
function activeTurnEvidence(extras) {
    const messages = extras.conversationMessages || [];
    return {
        // Canonical direct-AI placement. An empty array is meaningful for the
        // first hop of a turn and keeps every request on one stable shape.
        hops: extras.hops || [],
        ...(messages.length > 0 ? { conversation: { messages } } : {}),
    };
}
function activeSessionFields(extras) {
    return {
        activeSessionCount: extras.activeSessionCount ?? 0,
        sessionId: extras.currentSession?.sessionId ?? '',
        sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
        sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
        agentType: ingestionClient_1.AGENT_TYPE,
        machineId: extras.machineId ?? '',
        os: osAttribute(),
        // Same everywhere-precedent as agentType, but gated: agentType is a
        // compile-time constant the schema already accepts, whereas `model` is a
        // new attribute the schema must declare first.
        ...(extras.modelContext ? { model: extras.model ?? '' } : {}),
    };
}
function buildActionContext(mapping, extras = {}) {
    const timestamp = Date.now();
    const evidence = activeTurnEvidence(extras);
    const sessions = activeSessionFields(extras);
    switch (mapping.actionName) {
        case 'invokeTool':
            return { timestamp, ...evidence, ...sessions };
        case 'spawn':
            return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...evidence, ...sessions };
        case 'executeBash':
            return { timestamp, command: mapping.command ?? '', ...evidence, ...sessions };
        case 'read':
        case 'write':
        case 'edit':
        case 'glob':
        case 'grep':
            return { timestamp, ...evidence, ...sessions };
        default:
            return { timestamp, ...evidence, ...sessions };
    }
}
function buildInvokeAgentContext(activeSessionCount = 0, currentSession, extras = {}) {
    return {
        timestamp: Date.now(),
        hops: [],
        ...activeSessionFields({ activeSessionCount, currentSession, ...extras }),
    };
}
// `role`/`contentType`/`promptKey` are constants here — Codex doesn't
// expose a multi-role or multi-content-type concept at the hook level, only
// ever the current turn's plain-text prompt.
function buildTransmission(content, role, nonblankFallback) {
    const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
    if (!userQuery) {
        throw new Error('direct AI evaluation requires a nonblank current prompt');
    }
    return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}
// Sent once, as transmission.response on that tool call's PostToolUse
// request. An RTG 413 fails open for that request, so raise this only
// after confirming the RTG accepts the resulting request size.
const MAX_TOOL_RESPONSE_LENGTH = 10000;
function serializeToolResponse(toolResponse) {
    if (toolResponse == null)
        return '';
    const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    return raw.length > MAX_TOOL_RESPONSE_LENGTH ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…` : raw;
}
// PostToolUse: userQuery is the same current-hop prompt PreToolUse sent
// (command, pattern, serialized tool input, or tool name). The tool result
// goes in transmission.response, not userQuery — the RTG derives its
// managed prompt from userQuery. Role is "tool" because the tool has
// already returned. contentType stays text/plain, matching PreToolUse:
// response is always a string, JSON results included (see
// serializeToolResponse).
function buildToolResponseTransmission(toolResponse, userQuery) {
    const transmission = buildTransmission(userQuery, 'tool');
    transmission.response = serializeToolResponse(toolResponse);
    return transmission;
}
