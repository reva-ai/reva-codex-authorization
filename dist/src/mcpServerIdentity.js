"use strict";
// One identifier for an MCP server, shared by config discovery (mcpConfig.ts)
// and enforcement (mapping.ts). Both sides converge on a slug derived from
// the server token — "My_Server" / "my-server" -> my-server — so a Cedar
// policy written against one can match the other.
//
// MCP tools arrive as mcp__<server>__<tool> where <server> is the
// config.toml table name (or another host-supplied token), so resolve just
// slugifies; there is no identity cache. The url, when known, is looked up
// by the caller (mapMcpTool in mapping.ts, which already reads
// config.toml via mcpConfig.ts) and passed straight through here — kept
// out of this file so it stays free of a file-system dependency.
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugifyMcpServerName = slugifyMcpServerName;
exports.resolveMcpServerIdentity = resolveMcpServerIdentity;
function slugifyMcpServerName(raw) {
    if (typeof raw !== 'string')
        return '';
    return raw
        .toLowerCase()
        .replace(/[\s._]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}
// Invoke-time / config-time resolution of an MCP server token. Always
// slugifies — one id format across config.toml keys and mcp__ tool names.
//
// Known cost, accepted deliberately: slugify is many-to-one, so two
// genuinely different entries — "my_server" and "my-server" — collapse onto
// a single id. That is symmetric (enforcement collapses them the same way,
// so nothing is orphaned) and buys an id format that is predictable
// everywhere.
function resolveMcpServerIdentity(token, url) {
    const slug = slugifyMcpServerName(token) || token;
    return { slug, displayName: token, url };
}
