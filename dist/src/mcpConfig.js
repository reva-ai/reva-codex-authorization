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
exports.codexConfigPath = codexConfigPath;
exports.parseAllMcpServersToml = parseAllMcpServersToml;
exports.parseMcpServersToml = parseMcpServersToml;
exports.readAllMcpServers = readAllMcpServers;
exports.readRemoteMcpServers = readRemoteMcpServers;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const mcpServerIdentity_1 = require("./mcpServerIdentity");
function codexConfigPath(explicitPath) {
    if (explicitPath)
        return explicitPath;
    const codexHome = process.env.CODEX_HOME?.length
        ? process.env.CODEX_HOME
        : path.join(os.homedir(), '.codex');
    return path.join(codexHome, 'config.toml');
}
// Splits a table header's dotted path, respecting quoted segments so a
// server legitimately named "my.server" is not read as two components.
// Returns undefined when the header contains anything this reader does not
// confidently understand.
function splitHeaderPath(header) {
    const parts = [];
    let current = '';
    let quote;
    let quotedSegment = false;
    for (let i = 0; i < header.length; i++) {
        const ch = header[i];
        if (quote) {
            if (ch === quote)
                quote = undefined;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            quotedSegment = true;
            continue;
        }
        if (ch === '.') {
            parts.push(current);
            current = '';
            quotedSegment = false;
            continue;
        }
        if (ch === ' ' || ch === '\t')
            continue;
        // A bare (unquoted) key may only contain TOML's bare-key characters.
        if (!quotedSegment && !/[A-Za-z0-9_-]/.test(ch))
            return undefined;
        current += ch;
    }
    if (quote)
        return undefined; // unterminated quote — not understood
    parts.push(current);
    return parts.every((p) => p.length > 0) ? parts : undefined;
}
// Matches `url = "value"` / `url = 'value'` only. A url whose value is not a
// simple quoted basic string (an array, an inline table, a multi-line
// string, a bare token) is not understood and yields undefined.
function parseUrlValue(line) {
    const match = line.match(/^url\s*=\s*(.*)$/);
    if (!match)
        return undefined;
    const rest = match[1].trim();
    const quote = rest[0];
    if (quote !== '"' && quote !== "'")
        return undefined;
    const closing = rest.indexOf(quote, 1);
    if (closing < 1)
        return undefined;
    // Anything after the closing quote other than a comment means this line is
    // doing something this reader does not model.
    const trailing = rest.slice(closing + 1).trim();
    if (trailing && !trailing.startsWith('#'))
        return undefined;
    const value = rest.slice(1, closing).trim();
    return value.length > 0 ? value : undefined;
}
function parseAllMcpServersToml(tomlText) {
    const byName = new Map();
    // The server named by the current `[mcp_servers.<name>]` table, or
    // undefined whenever we are anywhere else in the file.
    let currentServer;
    for (const rawLine of tomlText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#'))
            continue;
        if (line.startsWith('[')) {
            currentServer = undefined;
            const close = line.indexOf(']');
            if (close < 0 || line.startsWith('[['))
                continue;
            const trailing = line.slice(close + 1).trim();
            if (trailing && !trailing.startsWith('#'))
                continue;
            const parts = splitHeaderPath(line.slice(1, close));
            if (parts && parts.length === 2 && parts[0] === 'mcp_servers') {
                // Slug so config keys and mcp__ tool-name tokens converge on one id.
                currentServer = (0, mcpServerIdentity_1.slugifyMcpServerName)(parts[1]) || parts[1];
                if (!byName.has(currentServer)) {
                    byName.set(currentServer, { name: currentServer });
                }
            }
            continue;
        }
        if (!currentServer)
            continue;
        const url = parseUrlValue(line);
        if (url) {
            byName.set(currentServer, { name: currentServer, url });
            currentServer = undefined;
        }
    }
    return [...byName.values()];
}
function parseMcpServersToml(tomlText) {
    return parseAllMcpServersToml(tomlText).flatMap((entry) => entry.url ? [{ name: entry.name, url: entry.url }] : []);
}
// Remote (url-bearing) MCP servers declared in Codex's config.toml. A stdio
// server has no URL at all and is skipped rather than ingested with a
// fabricated baseUrl. A missing config.toml is the common case, not an error.
function readAllMcpServers(explicitPath) {
    try {
        return parseAllMcpServersToml(fs.readFileSync(codexConfigPath(explicitPath), 'utf8'));
    }
    catch {
        return [];
    }
}
function readRemoteMcpServers(explicitPath) {
    return readAllMcpServers(explicitPath).flatMap((entry) => entry.url ? [{ name: entry.name, url: entry.url }] : []);
}
