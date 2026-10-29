"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRevaToml = parseRevaToml;
exports.readCodexRevaConfig = readCodexRevaConfig;
const fs = __importStar(require("node:fs"));
const mcpConfig_1 = require("./mcpConfig");
// Narrow TOML subset reader for Reva fields in ~/.codex/config.toml.
// Understands only:
//   [reva]              auth_token / agent_id / debug / host (and REVA_* / camelCase aliases)
//   [reva.env]          REVA_AUTH_TOKEN / REVA_AGENT_ID / REVA_DEBUG / REVA_HOST
// plus, for auth_token ONLY, three fallback placements users reach for when
// they skip the [reva] header:
//   top of the file (before any [header])
//   [plugins."reva-security@reva-plugins"]   next to enabled = true
//   [marketplaces.reva-plugins]
// Those two tables are this plugin's own, so an auth_token there can only
// mean ours. auth_token under ANY other table is deliberately ignored — under
// [mcp_servers.x] it may be that server's credential, and must never be sent
// to Reva. Confirmed live on Codex 0.162.1 that Codex itself accepts the
// extra key in both tables, but `codex plugin remove` / `codex plugin
// marketplace remove` delete the table, token included — hence [reva] stays
// the documented place and these are fallbacks only.
// Same posture as mcpConfig.ts: skip anything not confidently understood.
// `configPath` is for tests; production uses codexConfigPath() (~/.codex/config.toml).
function parseQuotedAssignment(line) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match)
        return undefined;
    const key = match[1];
    const rest = match[2].trim();
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") {
        // Allow bare true/false for debug, and bare 1/0 (common for REVA_DEBUG=1).
        const bare = rest.split(/\s+#/)[0]?.trim();
        if (bare === 'true' || bare === 'false' || bare === '1' || bare === '0') {
            return { key, value: bare };
        }
        return undefined;
    }
    const closing = rest.indexOf(quote, 1);
    if (closing < 1)
        return undefined;
    const trailing = rest.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith('#'))
        return undefined;
    return { key, value: rest.slice(1, closing) };
}
function pickString(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim())
            return v.trim();
    }
    return undefined;
}
function isTruthy(raw) {
    if (raw === undefined)
        return false;
    const v = raw.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false';
}
// Table names compared with quotes and whitespace stripped, so
// [plugins."reva-security@reva-plugins"], [plugins.'reva-security@reva-plugins']
// and [marketplaces."reva-plugins"] all match. Safe for these two names
// specifically: neither contains a dot inside its quoted segment.
const PLUGIN_TABLE = 'plugins.reva-security@reva-plugins';
const MARKETPLACE_TABLE = 'marketplaces.reva-plugins';
function normalizeTableName(name) {
    return name.replace(/["'\s]/g, '');
}
function parseRevaToml(tomlText) {
    const reva = {};
    const revaEnv = {};
    const fallbackToken = {};
    // Keys before the first header are top-level; once any header is seen,
    // nothing is top-level again for the rest of the file.
    let section = 'top';
    for (const rawLine of tomlText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        if (line.startsWith('[')) {
            section = 'other';
            const close = line.indexOf(']');
            if (close < 0 || line.startsWith('[['))
                continue;
            const trailing = line.slice(close + 1).trim();
            if (trailing && !trailing.startsWith('#'))
                continue;
            const name = line.slice(1, close).trim();
            if (name === 'reva')
                section = 'reva';
            else if (name === 'reva.env')
                section = 'reva.env';
            else if (normalizeTableName(name) === PLUGIN_TABLE)
                section = 'plugin';
            else if (normalizeTableName(name) === MARKETPLACE_TABLE)
                section = 'marketplace';
            continue;
        }
        if (section === 'other')
            continue;
        const parsed = parseQuotedAssignment(line);
        if (!parsed)
            continue;
        if (section === 'reva')
            reva[parsed.key] = parsed.value;
        else if (section === 'reva.env')
            revaEnv[parsed.key] = parsed.value;
        else if (parsed.key === 'auth_token')
            fallbackToken[section] = parsed.value;
    }
    const debugRaw = pickString(revaEnv.REVA_DEBUG, reva.debug, reva.REVA_DEBUG);
    return {
        authToken: pickString(revaEnv.REVA_AUTH_TOKEN, reva.auth_token, reva.authToken, reva.REVA_AUTH_TOKEN, fallbackToken.plugin, fallbackToken.marketplace, fallbackToken.top),
        host: pickString(revaEnv.REVA_HOST, reva.host, reva.REVA_HOST),
        agentId: pickString(revaEnv.REVA_AGENT_ID, reva.agent_id, reva.agentId, reva.REVA_AGENT_ID),
        debug: isTruthy(debugRaw) || undefined,
    };
}
function readCodexRevaConfig(configPath) {
    try {
        const raw = fs.readFileSync((0, mcpConfig_1.codexConfigPath)(configPath), 'utf8');
        return parseRevaToml(raw);
    }
    catch {
        return {};
    }
}
