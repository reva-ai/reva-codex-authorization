"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluate = evaluate;
const debug_1 = require("./debug");
const rtgCircuitBreaker_1 = require("./rtgCircuitBreaker");
const RTG_UNAVAILABLE = 'RTG_UNAVAILABLE';
const RTG_TIMEOUT = 'RTG_TIMEOUT';
const UNAUTHORIZED = 'UNAUTHORIZED';
const RTG_SERVER_ERROR = 'RTG_SERVER_ERROR';
const RTG_FAILED_DEPENDENCY = 'RTG_FAILED_DEPENDENCY';
const RTG_PAYLOAD_TOO_LARGE = 'RTG_PAYLOAD_TOO_LARGE';
const RTG_NOT_FOUND = 'RTG_NOT_FOUND';
// 401 is rarer and more likely to reflect a slower-moving problem (e.g.
// principal provisioning) than a transient RTG blip, so it gets a much
// longer window than anything else here — see rtgCircuitBreaker.ts.
class RtgTimeoutError extends Error {
}
function parseJson(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function errorTypeOf(json) {
    const value = json != null && typeof json === 'object' && !Array.isArray(json) ? json.error_type : undefined;
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function errorMessageOf(json) {
    if (json == null || typeof json !== 'object' || Array.isArray(json))
        return undefined;
    const contextReason = json.context?.reason;
    if (typeof contextReason === 'string' && contextReason.trim())
        return contextReason;
    for (const key of ['message', 'error', 'reason']) {
        const value = json[key];
        if (typeof value === 'string' && value.trim())
            return value;
    }
    return undefined;
}
// A 200 with body.guardrails.outcome === "conditional_allow" means the RTG
// ran synchronous guardrails and wants a human to confirm before proceeding
// — not a plain allow. Only this one outcome value is handled (confirmed by
// the user); any other/absent guardrails block still means plain allow, per
// the existing "200 is authoritative allow" contract.
function guardrailsOutcomeOf(json) {
    const guardrails = json != null && typeof json === 'object' && !Array.isArray(json) ? json.guardrails : undefined;
    if (guardrails == null || typeof guardrails !== 'object' || Array.isArray(guardrails))
        return {};
    return {
        outcome: typeof guardrails.outcome === 'string' ? guardrails.outcome : undefined,
        reason: typeof guardrails.reason === 'string' ? guardrails.reason : undefined,
    };
}
async function postJson(cfg, url, body, traceparent, threadId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Origin-App': 'CODEX',
                    'X-Reva-Verification-Codes': 'CODE_USER_SCOPE',
                    ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
                    ...(cfg.policyStoreId ? { policyStoreId: cfg.policyStoreId } : {}),
                    ...(traceparent ? { traceparent } : {}),
                    // The chat itself — Codex's own session_id, unchanged for every
                    // call in the conversation. Deliberately a header of its own
                    // rather than folded into traceparent: the trace id now scopes to
                    // a single turn, so without this there would be nothing tying one
                    // turn's calls to the next turn's. RTG only; ingestion does not
                    // send it.
                    ...(threadId ? { 'X-Reva-Thread-Id': threadId } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        }
        catch (err) {
            if (controller.signal.aborted) {
                throw new RtgTimeoutError(err?.message || 'RTG request timed out');
            }
            throw err;
        }
        const text = await res.text().catch(() => '');
        return { status: res.status, text, json: parseJson(text) };
    }
    finally {
        clearTimeout(timer);
    }
}
async function postToRtg(cfg, request, traceparent, threadId) {
    return postJson(cfg, cfg.rtgUrl, request, traceparent, threadId);
}
// Only 401 and 413 fail open here — everything else operational (404, 424,
// 5xx) now fails CLOSED (an active deny, not a silent pass-through), per
// explicit instruction: governance must hold even while Reva itself is
// erroring or unreachable, rather than degrade to "no extra governance for
// that moment." `inactive: true` is therefore only ever set on the 401/413
// branches below — everything else must reach Codex as an explicit
// deny (inactive would suppress that and let the action through).
//
// 401 additionally latches the circuit open FOR THIS SESSION
// (rtgCircuitBreaker.ts): since 401 fails OPEN (unlike everything else
// here), repeatedly hitting an unauthorized RTG would otherwise allow every
// single call for as long as the problem lasts. The latch stops the retrying
// without pretending the session is governed. It does not expire and there
// is no recovery within the session — starting a new session IS the
// recovery, and a new session always makes a real call. Nothing else here
// latches it: 404/424/5xx/429 already fail closed on every call, so there is
// no "keep allowing" window to bound.
function handleOperationalStatuses(res, cfg, pluginDataDir, sessionId) {
    if (res.status === 401) {
        const errorType = errorTypeOf(res.json) || UNAUTHORIZED;
        // Keyed by session, so one session's 401 never silences another —
        // including one started after the underlying problem was fixed.
        if (sessionId)
            (0, rtgCircuitBreaker_1.openCircuit)(sessionId, res.status, errorType, pluginDataDir);
        return {
            decision: 'deny',
            inactive: true,
            reason: `Reva authorization unavailable${errorType ? ` (${errorType})` : ''} — failing open for this request`,
            errorType,
            status: 401,
            raw: res.json ?? res.text,
        };
    }
    if (res.status === 413) {
        const errorType = errorTypeOf(res.json) || RTG_PAYLOAD_TOO_LARGE;
        return {
            decision: 'allow',
            inactive: true,
            reason: `Reva RTG rejected the request as too large (HTTP 413${errorType ? ` ${errorType}` : ''}) — failing open for this request`,
            errorType,
            status: 413,
            raw: res.json ?? res.text,
        };
    }
    if (res.status === 404) {
        const errorType = errorTypeOf(res.json) || RTG_NOT_FOUND;
        return {
            decision: 'deny',
            reason: errorMessageOf(res.json) || `Reva RTG could not resolve this request (HTTP 404${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
            errorType,
            status: 404,
            raw: res.json ?? res.text,
        };
    }
    if (res.status === 424) {
        const errorType = errorTypeOf(res.json) || RTG_FAILED_DEPENDENCY;
        return {
            decision: 'deny',
            reason: `Reva RTG error (HTTP 424${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
            errorType,
            status: 424,
            raw: res.json ?? res.text,
        };
    }
    if (res.status >= 500 && res.status < 600) {
        const errorType = errorTypeOf(res.json) || RTG_SERVER_ERROR;
        return {
            decision: 'deny',
            reason: `Reva RTG error (HTTP ${res.status}${errorType ? ` ${errorType}` : ''}) — blocked while Reva is unavailable`,
            errorType,
            status: res.status,
            raw: res.json ?? res.text,
        };
    }
    return undefined;
}
// A transport failure (connection refused, DNS failure, timeout — no HTTP
// response at all) gets the same fail-closed treatment as a 5xx: Reva being
// unreachable is not distinguishable from Reva being broken, and governance
// must hold either way. No circuit-breaker trip — same reasoning as 5xx/424
// above, there's no "keep allowing" window to cap since this already denies
// every time.
function handleTransportFailure(err) {
    const timedOut = err instanceof RtgTimeoutError;
    const errorType = timedOut ? RTG_TIMEOUT : RTG_UNAVAILABLE;
    const status = timedOut ? 504 : 503;
    return {
        decision: 'deny',
        reason: `Reva RTG ${errorType === RTG_TIMEOUT ? 'timed out' : 'is unavailable'} — blocked while Reva is unavailable`,
        errorType,
        status,
        raw: { error_type: errorType },
    };
}
async function evaluate(cfg, request, traceparent, pluginDataDir, threadId) {
    // With no session id there is nothing to key a latch by, so the call is
    // simply made — a 401 then fails open per-call, exactly as it would have
    // before any latch existed.
    const breaker = threadId ? (0, rtgCircuitBreaker_1.isCircuitOpen)(threadId, pluginDataDir) : { open: false };
    if (breaker.open) {
        (0, debug_1.debugLog)(`evaluate: RTG not called — circuit open for this session since ${new Date(breaker.openedAt).toISOString()} ` +
            `(HTTP ${breaker.triggeredStatus}${breaker.errorType ? ` ${breaker.errorType}` : ''}); a new session will call again`);
        return {
            decision: 'allow',
            inactive: true,
            reason: `Reva RTG is unavailable for this session (HTTP ${breaker.triggeredStatus}${breaker.errorType ? ` ${breaker.errorType}` : ''} at ${new Date(breaker.openedAt).toISOString()}) — failing open for this request`,
            errorType: breaker.errorType,
            status: breaker.triggeredStatus,
            raw: { circuitOpen: true, openedAt: breaker.openedAt },
        };
    }
    try {
        const res = await postToRtg(cfg, request, traceparent, threadId);
        // Logged once here, centrally, so every caller gets it for free rather
        // than each hook needing to remember to log the response itself — the
        // existing per-hook "<- decision=..." lines only summarize the outcome
        // this file already decided, not what RTG actually sent back.
        (0, debug_1.debugLog)(`evaluate: RTG responded HTTP ${res.status} ${JSON.stringify(res.json ?? res.text)}`);
        if (res.status === 200) {
            const guardrails = guardrailsOutcomeOf(res.json);
            if (guardrails.outcome === 'conditional_allow') {
                return {
                    decision: 'ask',
                    reason: guardrails.reason || 'Reva governance requires manual review for this request',
                    status: 200,
                    raw: res.json,
                };
            }
            return {
                // The direct-AI HTTP contract carries policy denial as 403. A 200 is
                // therefore authoritative allow regardless of a legacy/malformed
                // decision member in its body.
                decision: 'allow',
                status: 200,
                raw: res.json,
            };
        }
        if (res.status === 403) {
            // Always this fixed message on a policy deny, regardless of whatever
            // reason RTG's own response carries — per explicit instruction, the
            // end user sees a consistent, generic notice rather than RTG's
            // specific policy text. errorType is unaffected: still read from the
            // response, since that's a separate machine-readable signal, not the
            // human-facing message this instruction is about.
            return {
                decision: 'deny',
                reason: "Blocked by your organization's security policy.",
                errorType: errorTypeOf(res.json),
                status: 403,
                raw: res.json ?? res.text,
            };
        }
        const operational = handleOperationalStatuses(res, cfg, pluginDataDir, threadId);
        if (operational)
            return operational;
        // Every other status (including 429) is a real denial — e.g. policy or
        // input rejections, or rate-limiting from the RTG itself.
        return {
            decision: 'deny',
            reason: errorMessageOf(res.json) || `Reva RTG rejected the request (HTTP ${res.status}: ${res.text.slice(0, 300)})`,
            errorType: errorTypeOf(res.json),
            status: res.status,
            raw: res.json ?? res.text,
        };
    }
    catch (err) {
        (0, debug_1.debugLog)(`evaluate: RTG request failed — ${err?.message || String(err)}`);
        return handleTransportFailure(err);
    }
}
