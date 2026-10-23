"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const context_1 = require("./context");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const entity_1 = require("./entity");
const evaluateAll_1 = require("./evaluateAll");
const hookOutput_1 = require("./hookOutput");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const pluginPaths_1 = require("./pluginPaths");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
// PostToolUse fires after the tool has already run. An RTG deny cannot undo
// it — Codex replaces the tool result with the block reason so the model
// sees why, but the side effect has happened. Same fail-closed posture as
// PreToolUse for internal errors.
//
// IMPORTANT, and measured rather than assumed: PostToolUse is NOT
// guaranteed to fire for every PreToolUse. The 0.151.0 capture recorded 3
// apply_patch PreToolUse events against only 2 PostToolUse events. This
// entrypoint is therefore opportunistic evaluation, NOT a reliable audit
// backstop, and nothing else in this plugin is designed as if it were.
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const dataDir = (0, pluginPaths_1.resolveDataDir)();
    const machineId = (0, deviceId_1.resolveMachineId)(dataDir);
    // Read-only here, not a refresh — PreToolUse already marked this same
    // tool call's session active moments earlier in the same cycle.
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, dataDir);
    const currentSession = (0, activeSessions_1.getSessionEntry)(cfg.agentId, input.session_id, dataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    // Same canonicalization as PreToolUse, so pre and post map identically.
    const toolMapping = (0, mapping_1.mapToolToCedar)((0, mapping_1.canonicalToolName)(input.tool_name), input.tool_input || {}, input.cwd);
    // See the matching check in authorize.ts: an MCP tool call on a server
    // with no known url is out of governance scope entirely, true
    // pass-through, no RTG call.
    if (toolMapping.mappings.length > 0 && toolMapping.mappings.every((m) => m.skipReason)) {
        (0, debug_1.debugLog)(`authorizePost: skipping — ${toolMapping.mappings[0].skipReason}`);
        (0, hookOutput_1.passThroughAndExit)();
    }
    // Over-cap or unmappable: the tool has ALREADY RUN, so there is nothing to
    // prevent and denying would only replace a real result with an error the
    // model then has to reason about. Recorded and passed through instead —
    // the PreToolUse gate is where that call was, or was not, stopped.
    if (toolMapping.overCap || toolMapping.mappings.length === 0) {
        (0, debug_1.debugLog)(`PostToolUse: no evaluable resource for ${input.tool_name} ` +
            `(overCap=${Boolean(toolMapping.overCap)}, candidates=${toolMapping.candidateCount}) — passing through`);
        (0, hookOutput_1.passThroughAndExit)();
    }
    const turn = (0, turnCache_1.loadOrStartTurn)(input.session_id, input.turn_id, dataDir);
    // trace = this turn, span = this tool call. Same key PreToolUse used, so
    // the pair shares one span without shared state.
    const traceId = (0, trace_1.buildTraceId)(input.turn_id);
    const spanId = (0, trace_1.deriveSpanId)(traceId, `tool:${input.tool_name}:${JSON.stringify(input.tool_input || {})}`);
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, traceId);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.session_id, agentCtx.subAgentId, dataDir)
        : (0, hopChain_1.loadAgentHops)(input.session_id, dataDir);
    // Same current-hop prompt PreToolUse puts in transmission.userQuery.
    const serializedInput = JSON.stringify(input.tool_input || {});
    const currentHopContent = toolMapping.mappings[0].command?.trim() ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    // userQuery matches PreToolUse; the tool result is transmission.response,
    // not closed Cedar context, so the evaluate payload carries it without a
    // schema change.
    const transmission = (0, context_1.buildToolResponseTransmission)(input.tool_response, currentHopContent);
    const session = (0, turnCache_1.directSessionFromTurn)(input.session_id, turn);
    const conversationMessages = (0, turnCache_1.conversationFromTurn)(turn);
    const requests = toolMapping.mappings.map((mapping) => {
        const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: mapping.actionName },
            resource: (0, entity_1.directSpecOf)(resourceDescriptor),
            context: (0, context_1.buildActionContext)(mapping, {
                hops,
                conversationMessages,
                activeSessionCount,
                currentSession,
                model: input.model,
                modelContext: cfg.modelContext,
                machineId,
            }),
            transmission,
            session,
        };
        return { mapping, request };
    });
    (0, debug_1.debugLog)(`-> post ${input.tool_name} (turn=${input.turn_id}, resources=${requests.length}, hops=${hops.length})`);
    const aggregate = await (0, evaluateAll_1.evaluateAll)(cfg, requests, traceparent, dataDir, input.session_id);
    (0, debug_1.debugLog)(`<= PostToolUse outcome=${aggregate.outcome}`);
    switch (aggregate.outcome) {
        case 'deny':
            (0, hookOutput_1.denyAndExit)(aggregate.reason || "Blocked by your organization's security policy.");
        case 'ask':
            (0, hookOutput_1.additionalContextAndExit)('PostToolUse', (0, hookOutput_1.conditionalAllowNotice)(aggregate.reason, `the result of this ${input.tool_name} call`));
        case 'inactive':
            (0, hookOutput_1.passThroughAndExit)();
        default:
            (0, hookOutput_1.allowAndExit)();
    }
}
main().catch((err) => {
    (0, debug_1.debugLog)(`PostToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.denyAndExit)(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
