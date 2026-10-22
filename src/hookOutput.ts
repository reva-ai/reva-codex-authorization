// How a decision is communicated to Codex.
//
// This is a strict, host-specific contract, and every rule here is taken
// from Codex's own output parser
// (codex-rs/hooks/src/engine/output_parser.rs) and event modules
// (codex-rs/hooks/src/events/*.rs) at rust-v0.151.0 — not from prose docs,
// because the JSON Schemas accept several fields the runtime then rejects.
//
// DENY = exit code 2 with a non-empty stderr message.
//   Every blocking event (PreToolUse, PostToolUse, UserPromptSubmit) has
//   the same arm: `Some(2) if handler.can_apply_control_effects()` ->
//   HookRunStatus::Blocked, using trimmed stderr as the reason. An EMPTY
//   stderr on exit 2 downgrades to a non-blocking failure and the operation
//   proceeds, so the reason string is load-bearing, not decoration.
//
// ALLOW = exit 0 with EMPTY stdout.
//   There is deliberately no "allow" message. `permissionDecision: "allow"`
//   WITHOUT `updatedInput` is rejected outright as
//   "PreToolUse hook returned unsupported permissionDecision:allow", which
//   marks the run Failed. Emitting it would turn every allowed call into a
//   hook error, so an allow branch here emits nothing at all.
//
// NEVER EMITTED, at all, anywhere: `permissionDecision: "ask"` (rejected as
// unsupported and then SILENTLY ALLOWS, which is the worst possible
// outcome for a PEP), `decision: "approve"`, `continue`, `stopReason`,
// `suppressOutput`, `updatedInput`, `updatedMCPToolOutput`. Any one of them
// sets `invalid_reason`, and an invalid output discards the WHOLE decision —
// including a deny that was sent alongside it.
//
// Exit codes other than 0 and 2 are reported as a hook failure and the
// operation CONTINUES. That is why an internal error must exit 2, not 1.

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart';

// Codex uses the entire trimmed stderr as the block reason. With
// REVA_DEBUG=1, debugLog() also writes to stderr, so debug lines will be
// included in the reason the model sees on a deny. That is accepted rather
// than worked around: REVA_DEBUG is opt-in and off in normal use, and the
// real reason is still present in full.
export function denyAndExit(reason: string): never {
  const message = reason.trim() || "Blocked by your organization's security policy.";
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export function allowAndExit(): never {
  // No stdout. See above — an explicit allow is rejected by the parser.
  process.exit(0);
}

// Used for an inactive RTG (401/5xx/timeout/network). Indistinguishable on
// the wire from a plain allow, which is exactly right: an RTG outage must
// leave Codex's own native permission behaviour in control rather than
// forcing either answer.
export function passThroughAndExit(): never {
  process.exit(0);
}

// The only channel a non-blocking advisory has. `additionalContext` is
// honored on PreToolUse, PostToolUse, UserPromptSubmit and SessionStart
// alike, and is the landing place for an RTG `conditional_allow` — see
// askContext() callers. Emitted alone, with no decision field beside it, so
// nothing in the payload can invalidate it.
export function additionalContextAndExit(hookEventName: HookEventName, additionalContext: string): never {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
  process.exit(0);
}

// Wording shared by every entrypoint's conditional_allow path, so the
// degradation reads identically wherever it surfaces.
//
// An RTG `conditional_allow` means "a human should confirm this". Codex has
// no way for a PreToolUse hook to request that: `permissionDecision:"ask"`
// is parsed and then discarded. Rather than silently allowing (what "ask"
// would do) or denying (which would make one RTG response mean different
// things depending on which host asked, defeating the point of one shared
// evaluation contract), the requirement is surfaced to the model as an
// advisory note.
export function conditionalAllowNotice(reason: string | undefined, what: string): string {
  return (
    `Reva governance: ${what} requires elevated review ` +
    `(${reason || 'conditional policy match'}). Codex cannot prompt for confirmation from a hook, ` +
    `so this is advisory only and the action was not blocked.`
  );
}
