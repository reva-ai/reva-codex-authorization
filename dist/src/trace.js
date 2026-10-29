"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTraceId = buildTraceId;
exports.deriveSpanId = deriveSpanId;
exports.toolSpanKey = toolSpanKey;
exports.buildSessionContext = buildSessionContext;
exports.traceparentHeader = traceparentHeader;
// Trace-context identifier and header helpers.
const node_crypto_1 = require("node:crypto");
// Three distinct identifiers, one per level of the hierarchy. Getting the
// levels right is the whole point:
//
//   thread  — the chat. Codex's own session_id, sent as the
//             X-Reva-Thread-Id header on every RTG call. Constant from the
//             first prompt of a conversation to the last; changes only when
//             a new chat is started.
//   trace   — one user turn. Derived from Codex's required `turn_id`
//             (sha256(turn_id).slice(0,32)), so every hook in that turn
//             agrees without shared state. The next turn gets a new one.
//   span    — one operation inside the turn: for a tool call, one resource
//             of that call. Derived, not random, so the PreToolUse and
//             PostToolUse halves for the SAME resource land on the same span:
//             both hooks see identical tool_name and tool_input and map them
//             to the same resources, so both compute the same value with no
//             shared state. See deriveSpanId's own note on the collision this
//             accepts.
//
// Before this, traceId was a hash of session_id (constant for the entire
// session) and spanId was a hash of turn_id — the levels were each one step
// too high, and there was no thread header at all.
//
// Codex's turn_id is REQUIRED on every turn-scoped hook, so the trace id is
// deterministic from the host rather than minted and pinned in a turn cache.
// 32 hex chars, W3C traceparent trace-id. Deterministic per Codex turn_id
// so every hook in that turn agrees without any shared state.
function buildTraceId(turnId) {
    return (0, node_crypto_1.createHash)('sha256').update(turnId).digest('hex').slice(0, 32);
}
// 16 hex chars, W3C traceparent parent-id (span). Derived from the trace plus
// a caller-supplied key describing the operation.
//
// The key for a tool call is tool_name + tool_input + action + resource (see
// toolSpanKey), which PreToolUse and PostToolUse both have and which are
// identical between them — that is what makes each pair share a span without
// any state passing between the two processes.
//
// Accepted consequence: two genuinely separate calls with identical input in
// one turn (the same bash command run twice) collapse onto one span. They
// stay under the correct trace, so the turn is still whole; they just are not
// distinguishable from each other within it.
function deriveSpanId(traceId, key) {
    return (0, node_crypto_1.createHash)('sha256').update(`${traceId}:${key}`).digest('hex').slice(0, 16);
}
// The span key for ONE RESOURCE of a tool call. A single call can map to
// several resources (`cd /repo && rm test.js` -> Directory:repo and
// File:test.js; one apply_patch can name several files), and PreToolUse sends
// one request per resource. Sharing one span across them made the decision
// log pair the second PRE request with the first and label it Post-Tool, even
// when PostToolUse never ran. One span per resource fixes that: PostToolUse
// maps the same input to the same resources, so each pre/post pair still
// meets on one span without shared state.
//
// Keyed on resourceId, NOT resourceType: a path the call deletes can classify
// differently afterwards (File before, Directory after, once it no longer
// exists to stat), which would split that pair across two spans.
function toolSpanKey(toolName, toolInput, mapping) {
    return `tool:${toolName}:${JSON.stringify(toolInput || {})}:${mapping.actionName}:${mapping.resourceId}`;
}
function buildSessionContext(sessionId, spanId, traceId, id) {
    return { id: id || sessionId, traceId, spanId };
}
function traceparentHeader(traceId, spanId) {
    return `00-${traceId}-${spanId}-01`;
}
