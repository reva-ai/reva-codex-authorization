"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateAll = evaluateAll;
const debug_1 = require("./debug");
const rtgClient_1 = require("./rtgClient");
function describe(mapping) {
    return `${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId}`;
}
async function evaluateAll(cfg, requests, traceparent, pluginDataDir, threadId) {
    const evaluated = await Promise.all(requests.map(async ({ mapping, request }) => ({
        mapping,
        result: await (0, rtgClient_1.evaluate)(cfg, request, traceparent, pluginDataDir, threadId),
    })));
    for (const { mapping, result } of evaluated) {
        (0, debug_1.debugLog)(`<- ${describe(mapping)} => ${result.inactive ? 'inactive' : result.decision}` +
            `${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`);
    }
    // An inactive result carries no opinion at all — it is an RTG outage, not a
    // verdict — so it neither blocks nor satisfies. Filtering them out first
    // means a mixed batch is decided by the resources that DID get a real
    // answer, and a wholly inactive batch passes through untouched.
    const active = evaluated.filter((e) => !e.result.inactive);
    if (active.length === 0) {
        return { outcome: 'inactive', evaluated };
    }
    const denied = active.find((e) => e.result.decision === 'deny');
    if (denied) {
        return {
            outcome: 'deny',
            // Naming the specific resource matters: with N resources per call, a
            // bare "denied by policy" leaves no way to tell which path was the
            // problem, and the whole point of deny-if-any is that any one of them
            // can be.
            reason: `${denied.result.reason || "Blocked by your organization's security policy."} ` +
                `[resource: ${describe(denied.mapping)}]` +
                (active.length > 1 ? ` (${active.length} resources evaluated for this one tool call)` : ''),
            evaluated,
        };
    }
    const asked = active.find((e) => e.result.decision === 'ask');
    if (asked) {
        return {
            outcome: 'ask',
            reason: `${asked.result.reason || 'conditional policy match'} [resource: ${describe(asked.mapping)}]`,
            evaluated,
        };
    }
    return { outcome: 'allow', evaluated };
}
