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

export interface McpServerIdentity {
  // The canonical id — what both MCPServer entity ids and Cedar policies use.
  slug: string;
  // Human-readable name, when one is known. Usually the original config key
  // before slugifying.
  displayName?: string;
  // Present only when the caller resolved a real config.toml entry for this
  // server; absent for a stdio server, an app-provided one, or one not yet
  // discovered. See mapping.ts's skipReason for what no url means for
  // authorization, and ingestionClient.ts for what it means for ingestion.
  url?: string;
}

export function slugifyMcpServerName(raw: string): string {
  if (typeof raw !== 'string') return '';
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
export function resolveMcpServerIdentity(token: string, url?: string): McpServerIdentity {
  const slug = slugifyMcpServerName(token) || token;
  return { slug, displayName: token, url };
}
