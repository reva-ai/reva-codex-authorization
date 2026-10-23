"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInvokeAgentRequest = buildInvokeAgentRequest;
const context_1 = require("./context");
const entity_1 = require("./entity");
// Canonical direct-AI invokeAgent envelope (User → Agent), used by the
// per-turn UserPromptSubmit gate.
function buildInvokeAgentRequest(userEmail, agentId, prompt, session, activeSessionCount = 0, currentSession, extras = {}) {
    // User's schema-declared SCIM attributes have no trustworthy source in
    // this hook, so send a bare direct spec and let RTG resolve the provisioned
    // entity by type/id rather than fabricating request properties.
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    // User/Agent identities are deliberately bare. RTG Edge resolves their
    // authoritative attributes from its entity store; principal already carries
    // the human relationship for this evaluation.
    const agentDescriptor = (0, entity_1.buildEntityDescriptor)('Agent', agentId);
    return {
        // subject = principal here: the human IS the one directly invoking —
        // there's no intermediate acting entity yet.
        subject: (0, entity_1.directSpecOf)(userDescriptor),
        principal: (0, entity_1.directSpecOf)(userDescriptor),
        action: { name: 'invokeAgent' },
        resource: (0, entity_1.directSpecOf)(agentDescriptor),
        context: (0, context_1.buildInvokeAgentContext)(activeSessionCount, currentSession, extras),
        transmission: (0, context_1.buildTransmission)(prompt, 'user'),
        session,
    };
}
