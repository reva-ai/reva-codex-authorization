"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const hookOutput_1 = require("./hookOutput");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const invokeAgent_1 = require("./invokeAgent");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const rtgClient_1 = require("./rtgClient");
const pluginPaths_1 = require("./pluginPaths");
const spawnCounter_1 = require("./spawnCounter");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
// UserPromptSubmit gates the whole turn: one invokeAgent evaluation of
// User -> Agent, before Codex does anything with the prompt.
//
// Single-resource by nature — the resource is the Agent itself — so this is
// the one entrypoint that does not go through evaluateAll().
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const dataDir = (0, pluginPaths_1.resolveDataDir)();
    // Closes the gap between SessionStart's once-per-session discovery pass
    // and an MCP server added mid-session: UserPromptSubmit fires every turn,
    // so re-checking here (throttled to ~15 minutes, see
    // mcpIngestionTrigger.ts) picks up a new server well before the next
    // SessionStart would. A no-op, non-blocking cache read when not yet due.
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)(input.cwd, dataDir);
    const userEmail = (0, identity_1.resolveUserEmail)();
    const prompt = input.prompt ? (0, turnCache_1.truncatePrompt)(input.prompt) : '';
    // UserPromptSubmit fires every turn, unlike SessionStart (once per
    // session) — a good second place to keep this session's lastSeen fresh.
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.session_id, (0, identity_1.resolveSessionEntrypoint)(), dataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, dataDir);
    // Codex's own turn_id is the turn boundary — this plugin no longer has to
    // mint one. startTurn records the prompt against it and advances the
    // ordinal that DirectEvalSession.turn needs.
    const turn = (0, turnCache_1.startTurn)(input.session_id, input.turn_id, input.prompt, dataDir);
    // Same turn boundary resets the subagent spawn counter — each turn's
    // first spawn is #1 again, not a continuation of every prior turn's count
    // (see spawnCounter.ts's own comment on why).
    (0, spawnCounter_1.resetSpawnCounter)(input.session_id, dataDir);
    // This hook opens the turn, so its trace id is the one every tool call in
    // the turn will derive. Its own span is the prompt evaluation itself.
    const traceId = (0, trace_1.buildTraceId)(input.turn_id);
    const spanId = (0, trace_1.deriveSpanId)(traceId, 'user-prompt');
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, traceId);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    const request = (0, invokeAgent_1.buildInvokeAgentRequest)(userEmail, cfg.agentId, prompt, (0, turnCache_1.directSessionFromTurn)(input.session_id, turn), activeSessionCount, currentSession, 
    // `model` comes straight off the hook payload, where Codex declares it
    // required. Only reaches context when REVA_MODEL_CONTEXT is set.
    {
        model: input.model,
        modelContext: cfg.modelContext,
        machineId: (0, deviceId_1.resolveMachineId)(dataDir),
    });
    (0, debug_1.debugLog)(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} (turn=${input.turn_id})`);
    const result = await (0, rtgClient_1.evaluate)(cfg, request, traceparent, dataDir, input.session_id);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.inactive ? ' (inactive)' : ''}${result.reason ? ` reason="${result.reason}"` : ''}`);
    // Record this invokeAgent as the base of this turn's hop chain regardless
    // of the decision, so a subsequent tool call (if the turn proceeds) has it
    // to build on — mirrors how the spawn counter also advances on every
    // attempt, not just approved ones.
    const invokeAgentHop = {
        seq: 1,
        subject: request.subject,
        action: { name: 'invokeAgent' },
        resource: request.resource,
        time: new Date().toISOString(),
    };
    (0, hopChain_1.startTurnHops)(input.session_id, invokeAgentHop, dataDir);
    if (result.inactive)
        (0, hookOutput_1.passThroughAndExit)();
    if (result.decision === 'deny')
        (0, hookOutput_1.denyAndExit)(result.reason || "Blocked by your organization's security policy.");
    if (result.decision === 'ask') {
        (0, hookOutput_1.additionalContextAndExit)('UserPromptSubmit', (0, hookOutput_1.conditionalAllowNotice)(result.reason, 'this session'));
    }
    (0, hookOutput_1.allowAndExit)();
}
main().catch((err) => {
    (0, debug_1.debugLog)(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.denyAndExit)(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
