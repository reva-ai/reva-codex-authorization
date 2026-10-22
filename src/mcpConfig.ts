import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { slugifyMcpServerName } from './mcpServerIdentity';

// Reads remote MCP server declarations out of Codex's config.toml.
//
// Codex has no `.mcp.json` and no confirmed `claude mcp list` equivalent —
// MCP servers are declared as `[mcp_servers.<name>]` tables in
// $CODEX_HOME/config.toml. Codex's own RawMcpServerConfig
// (codex-rs/config/src/mcp_types.rs, rust-v0.151.0) carries `url` for
// streamable-http servers and `command`/`args` for stdio ones, so a real
// baseUrl is available for exactly the remote servers — which is all the
// MCPServer entity can honestly be created from.
//
// THIS IS NOT A TOML PARSER. It is a deliberately narrow subset reader that
// understands exactly two things: `[mcp_servers.<name>]` table headers and a
// `url = "..."` key inside one. Everything else — inline tables, arrays,
// multi-line strings, nested subtables, dotted keys — is SKIPPED SILENTLY.
//
// The one rule that governs every ambiguous case: on anything it does not
// understand, skip the entry rather than guess. Under-ingesting is benign
// (the MCPServer entity simply isn't created ahead of time); mis-ingesting
// writes a wrong baseUrl into the customer's entity store, which is not.
// Adding a real TOML dependency would break the zero-runtime-dependency
// property that lets this plugin be dropped onto a machine and run.

export interface McpServerEntry {
  name: string;
  url: string;
}

export interface McpServerConfigEntry {
  name: string;
  url?: string;
}

export function codexConfigPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const codexHome = process.env.CODEX_HOME?.length
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

// Splits a table header's dotted path, respecting quoted segments so a
// server legitimately named "my.server" is not read as two components.
// Returns undefined when the header contains anything this reader does not
// confidently understand.
function splitHeaderPath(header: string): string[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let quotedSegment = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
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
    if (ch === ' ' || ch === '\t') continue;
    // A bare (unquoted) key may only contain TOML's bare-key characters.
    if (!quotedSegment && !/[A-Za-z0-9_-]/.test(ch)) return undefined;
    current += ch;
  }
  if (quote) return undefined; // unterminated quote — not understood
  parts.push(current);
  return parts.every((p) => p.length > 0) ? parts : undefined;
}

// Matches `url = "value"` / `url = 'value'` only. A url whose value is not a
// simple quoted basic string (an array, an inline table, a multi-line
// string, a bare token) is not understood and yields undefined.
function parseUrlValue(line: string): string | undefined {
  const match = line.match(/^url\s*=\s*(.*)$/);
  if (!match) return undefined;
  const rest = match[1].trim();
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") return undefined;
  const closing = rest.indexOf(quote, 1);
  if (closing < 1) return undefined;
  // Anything after the closing quote other than a comment means this line is
  // doing something this reader does not model.
  const trailing = rest.slice(closing + 1).trim();
  if (trailing && !trailing.startsWith('#')) return undefined;
  const value = rest.slice(1, closing).trim();
  return value.length > 0 ? value : undefined;
}

export function parseAllMcpServersToml(tomlText: string): McpServerConfigEntry[] {
  const byName = new Map<string, McpServerConfigEntry>();
  // The server named by the current `[mcp_servers.<name>]` table, or
  // undefined whenever we are anywhere else in the file.
  let currentServer: string | undefined;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      currentServer = undefined;
      const close = line.indexOf(']');
      if (close < 0 || line.startsWith('[[')) continue;
      const trailing = line.slice(close + 1).trim();
      if (trailing && !trailing.startsWith('#')) continue;
      const parts = splitHeaderPath(line.slice(1, close));
      if (parts && parts.length === 2 && parts[0] === 'mcp_servers') {
        // Slug so config keys and mcp__ tool-name tokens converge on one id.
        currentServer = slugifyMcpServerName(parts[1]) || parts[1];
        if (!byName.has(currentServer)) {
          byName.set(currentServer, { name: currentServer });
        }
      }
      continue;
    }

    if (!currentServer) continue;
    const url = parseUrlValue(line);
    if (url) {
      byName.set(currentServer, { name: currentServer, url });
      currentServer = undefined;
    }
  }
  return [...byName.values()];
}

export function parseMcpServersToml(tomlText: string): McpServerEntry[] {
  return parseAllMcpServersToml(tomlText).flatMap((entry) =>
    entry.url ? [{ name: entry.name, url: entry.url }] : [],
  );
}

// Remote (url-bearing) MCP servers declared in Codex's config.toml. A stdio
// server has no URL at all and is skipped rather than ingested with a
// fabricated baseUrl. A missing config.toml is the common case, not an error.
export function readAllMcpServers(explicitPath?: string): McpServerConfigEntry[] {
  try {
    return parseAllMcpServersToml(fs.readFileSync(codexConfigPath(explicitPath), 'utf8'));
  } catch {
    return [];
  }
}

export function readRemoteMcpServers(explicitPath?: string): McpServerEntry[] {
  return readAllMcpServers(explicitPath).flatMap((entry) =>
    entry.url ? [{ name: entry.name, url: entry.url }] : [],
  );
}
