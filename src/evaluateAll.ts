import { debugLog } from './debug';
import { evaluate } from './rtgClient';
import { CedarActionMapping, CedarRequest, RtgResult, RevaConfig } from './types';

// ONE Codex hook call can touch MANY resources. Cedar takes one resource per
// request, and the hook fires once with a single allow/deny, so the plugin
// evaluates every resource the call touches and composes the answers.
//
// Composition is DENY-IF-ANY. This is the only rule under which a
// file-level policy means what it says: evaluating one resource and
// ignoring the rest would let `Get-Content README.md; Get-Content .env`
// pass on the strength of README.md, and evaluating a common-ancestor
// directory instead would widen the resource until Cedar's `in` no longer
// relates it to the forbidden subtree. Both of those fail toward SILENT
// PERMISSION; this one fails toward a visible denial.
//
// Evaluated in PARALLEL, not sequentially. Sequential worst case is
// N x REVA_PDP_TIMEOUT_MS (6 x 25s = 150s), which is inside the hook
// timeout but a miserable p99 on an interactive tool call. Parallel keeps
// wall-clock at roughly one round trip at the cost of N simultaneous
// requests — see the README's note on validating that load with the
// platform side before rollout.

export type AggregateOutcome = 'allow' | 'deny' | 'ask' | 'inactive';

export interface EvaluatedResource {
  mapping: CedarActionMapping;
  result: RtgResult;
}

export interface AggregateResult {
  outcome: AggregateOutcome;
  reason?: string;
  evaluated: EvaluatedResource[];
}

function describe(mapping: CedarActionMapping): string {
  return `${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId}`;
}

export async function evaluateAll(
  cfg: RevaConfig,
  // Each request carries its own traceparent: one span per resource, so the
  // decision log pairs every resource's pre and post records separately.
  requests: { mapping: CedarActionMapping; request: CedarRequest; traceparent: string }[],
  pluginDataDir?: string,
  threadId?: string,
): Promise<AggregateResult> {
  const evaluated: EvaluatedResource[] = await Promise.all(
    requests.map(async ({ mapping, request, traceparent }) => ({
      mapping,
      result: await evaluate(cfg, request, traceparent, pluginDataDir, threadId),
    })),
  );

  for (const { mapping, result } of evaluated) {
    debugLog(
      `<- ${describe(mapping)} => ${result.inactive ? 'inactive' : result.decision}` +
        `${result.status ? ` (HTTP ${result.status})` : ''}${result.reason ? ` reason="${result.reason}"` : ''}`,
    );
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
      reason:
        `${denied.result.reason || "Blocked by your organization's security policy."} ` +
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
