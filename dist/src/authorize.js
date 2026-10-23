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
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const pluginPaths_1 = require("./pluginPaths");
const spawnCounter_1 = require("./spawnCounter");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const dataDir = (0, pluginPaths_1.resolveDataDir)();
    const machineId = (0, deviceId_1.resolveMachineId)(dataDir);
    // Refreshes lastSeen for this session_id — keeps the active-sessions
    // registry accurate for as long as the session keeps being used. Same for
    // a subagent's own tool calls: agentCtx.agentId is always this machine's
    // id regardless of subagent status, so this still refreshes the right entry.
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.session_id, (0, identity_1.resolveSessionEntrypoint)(), dataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, dataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    // Namespaced hook names ("collaborationspawn_agent") are mapped under the
    // official tool name — see canonicalToolName in mapping.ts.
    const toolMapping = (0, mapping_1.mapToolToCedar)((0, mapping_1.canonicalToolName)(input.tool_name), input.tool_input || {}, input.cwd);
    // An MCP tool call on a server with no known url — see mapping.ts's
    // skipReason. True pass-through: no stdout at all, never an explicit
    // allow, so Codex's own permission system still decides. Also means
    // ingest-on-invoke below never fires for one of these — correct, since
    // there is nothing to ingest it as (see ingestionClient.ts).
    if (toolMapping.mappings.length > 0 && toolMapping.mappings.every((m) => m.skipReason)) {
        (0, debug_1.debugLog)(`authorize: skipping — ${toolMapping.mappings[0].skipReason}`);
        (0, hookOutput_1.passThroughAndExit)();
    }
    // Ingest-on-invoke — an MCP server being used but not yet ingested gets a
    // discovery pass triggered now instead of at the next recheck. Wrapped in
    // its own try/catch on purpose: main()'s catch below fails CLOSED, so an
    // unexpected throw in this best-effort bookkeeping would DENY a legitimate
    // tool call. Nothing here is worth blocking a user's work over, so it is
    // contained and swallowed rather than allowed to reach that handler.
    try {
        const mcpServer = toolMapping.mappings
            .flatMap((m) => m.resourceParents || [])
            .find((parent) => parent.type === 'MCPServer');
        if (mcpServer)
            (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)(mcpServer.id, input.cwd, dataDir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
    }
    (0, debug_1.debugLog)(`-> ${input.tool_name} (turn=${input.turn_id}) touches ${toolMapping.candidateCount} resource(s): ` +
        `${toolMapping.mappings.map((m) => `${m.actionName}:${m.resourceId}`).join(', ') || '(none)'}`);
    // Over the Bash resource cap. Denied rather than partially evaluated:
    // evaluating a subset would silently let the uninspected remainder
    // through, which is the failure direction this plugin exists to prevent.
    if (toolMapping.overCap) {
        (0, hookOutput_1.denyAndExit)(`Reva governance: this command touches ${toolMapping.candidateCount} distinct paths, above the ` +
            `${mapping_1.MAX_BASH_RESOURCES}-resource limit for a single evaluated call. Split it into separate commands so each ` +
            `can be authorized against policy.`);
    }
    // No identifiable resource at all. For Bash this cannot happen (it falls
    // back to the working directory); for apply_patch it means the patch
    // envelope could not be parsed, and a mutation whose target is unknown is
    // exactly the case that must not pass silently.
    if (toolMapping.mappings.length === 0) {
        (0, hookOutput_1.denyAndExit)(`Reva governance: could not determine which resources "${input.tool_name}" would act on, so it cannot be ` +
            `authorized. Failing closed.`);
    }
    // Codex supplies turn_id on every turn-scoped hook. trace = this turn
    // (shared by every call the prompt fans out into), span = this tool call.
    // The span key is tool_name + tool_input, which PostToolUse sees
    // identically, so the pre/post pair shares one span without either process
    // having to tell the other anything. loadOrStartTurn only persists what
    // turn_id can't give us: the prompt text, the turn ordinal and startedAt.
    const turn = (0, turnCache_1.loadOrStartTurn)(input.session_id, input.turn_id, dataDir);
    const traceId = (0, trace_1.buildTraceId)(input.turn_id);
    const spanId = (0, trace_1.deriveSpanId)(traceId, `tool:${input.tool_name}:${JSON.stringify(input.tool_input || {})}`);
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, traceId);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    // Cumulative spawn count for this turn — only computed (and only
    // increments) for actual spawns, so unrelated tool calls don't advance it.
    const isSpawn = toolMapping.mappings.some((m) => m.actionName === 'spawn');
    const subagentIndex = isSpawn ? (0, spawnCounter_1.nextSpawnIndex)(input.session_id, dataDir) : undefined;
    // principal: the human who ultimately initiated this chain — resolved the
    // same way regardless of who's directly acting (Agent or SubAgent).
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    // subject: no parents on SubAgent — the schema declares SubAgent's
    // memberOfTypes as [], so it isn't valid for a SubAgent to claim
    // membership in Agent (or anything else).
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const subject = (0, entity_1.refOf)(subjectDescriptor);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.session_id, agentCtx.subAgentId, dataDir)
        : (0, hopChain_1.loadAgentHops)(input.session_id, dataDir);
    // The current transmission describes this tool hop. If the host calls this
    // hook without UserPromptSubmit, use only real action data observed here,
    // because the endpoint rejects a blank current prompt.
    const serializedInput = JSON.stringify(input.tool_input || {});
    const currentHopContent = toolMapping.mappings[0].command?.trim() ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    const transmission = (0, context_1.buildTransmission)(currentHopContent, 'assistant', input.tool_name);
    const session = (0, turnCache_1.directSessionFromTurn)(input.session_id, turn);
    const conversationMessages = (0, turnCache_1.conversationFromTurn)(turn);
    // One CedarRequest per resource this single tool call touches. Everything
    // except `resource` and the per-action context is identical across them,
    // so the RTG sees N views of one action rather than N unrelated actions.
    const requests = toolMapping.mappings.map((mapping) => {
        const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
        const request = {
            subject: (0, entity_1.directSpecOf)(subjectDescriptor),
            principal: (0, entity_1.directSpecOf)(userDescriptor),
            action: { name: mapping.actionName },
            resource: (0, entity_1.directSpecOf)(resourceDescriptor),
            context: (0, context_1.buildActionContext)(mapping, {
                subagentIndex,
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
    // If this action IS a spawn, queue the lineage the resulting subagent
    // should inherit — see hopChain.ts for why this is a FIFO queue and what
    // would have to be observed to replace it with SubagentStart's agent_id.
    if (isSpawn) {
        const spawnMapping = toolMapping.mappings.find((m) => m.actionName === 'spawn');
        const spawnHop = {
            seq: hops.length + 1,
            subject,
            action: { name: 'spawn' },
            resource: { type: spawnMapping.resourceType, id: spawnMapping.resourceId },
            time: new Date().toISOString(),
        };
        (0, hopChain_1.enqueuePendingSpawnLineage)(input.session_id, hops, spawnHop, dataDir);
    }
    const aggregate = await (0, evaluateAll_1.evaluateAll)(cfg, requests, traceparent, dataDir, input.session_id);
    (0, debug_1.debugLog)(`<= PreToolUse outcome=${aggregate.outcome}`);
    switch (aggregate.outcome) {
        case 'deny':
            (0, hookOutput_1.denyAndExit)(aggregate.reason || "Blocked by your organization's security policy.");
        // falls through to exit; `denyAndExit` returns never
        case 'ask':
            (0, hookOutput_1.additionalContextAndExit)('PreToolUse', (0, hookOutput_1.conditionalAllowNotice)(aggregate.reason, `this ${input.tool_name} call`));
        case 'inactive':
            (0, hookOutput_1.passThroughAndExit)();
        default:
            (0, hookOutput_1.allowAndExit)();
    }
}
main().catch((err) => {
    // Any unexpected failure (bad stdin JSON, missing token, mapping bug) must
    // fail CLOSED. Exit 2 is the only non-zero code Codex treats as blocking —
    // exiting 1 would be reported as a hook failure and the tool call would
    // proceed, which is precisely the silent-permission outcome to avoid.
    // The ONLY record this denial leaves. denyAndExit exits the process
    // immediately after printing the hook response, so without this line a
    // fail-closed deny is invisible everywhere except the UI toast the user
    // sees — which is exactly why an intermittent config failure looked
    // random and undiagnosable.
    (0, debug_1.debugLog)(`PreToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    (0, hookOutput_1.denyAndExit)(`Reva governance plugin internal error — failing closed (${err?.message || String(err)})`);
});
