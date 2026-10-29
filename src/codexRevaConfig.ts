import * as fs from 'node:fs';
import { codexConfigPath } from './mcpConfig';

export type CodexRevaConfig = {
  authToken?: string;
  host?: string;
  agentId?: string;
  debug?: boolean;
};

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

function parseQuotedAssignment(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
  if (!match) return undefined;
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
  if (closing < 1) return undefined;
  const trailing = rest.slice(closing + 1).trim();
  if (trailing && !trailing.startsWith('#')) return undefined;
  return { key, value: rest.slice(1, closing) };
}

function pickString(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

// Table names compared with quotes and whitespace stripped, so
// [plugins."reva-security@reva-plugins"], [plugins.'reva-security@reva-plugins']
// and [marketplaces."reva-plugins"] all match. Safe for these two names
// specifically: neither contains a dot inside its quoted segment.
const PLUGIN_TABLE = 'plugins.reva-security@reva-plugins';
const MARKETPLACE_TABLE = 'marketplaces.reva-plugins';

function normalizeTableName(name: string): string {
  return name.replace(/["'\s]/g, '');
}

type Section = 'top' | 'other' | 'reva' | 'reva.env' | 'plugin' | 'marketplace';

export function parseRevaToml(tomlText: string): CodexRevaConfig {
  const reva: Record<string, string> = {};
  const revaEnv: Record<string, string> = {};
  const fallbackToken: Partial<Record<'top' | 'plugin' | 'marketplace', string>> = {};
  // Keys before the first header are top-level; once any header is seen,
  // nothing is top-level again for the rest of the file.
  let section: Section = 'top';

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      section = 'other';
      const close = line.indexOf(']');
      if (close < 0 || line.startsWith('[[')) continue;
      const trailing = line.slice(close + 1).trim();
      if (trailing && !trailing.startsWith('#')) continue;
      const name = line.slice(1, close).trim();
      if (name === 'reva') section = 'reva';
      else if (name === 'reva.env') section = 'reva.env';
      else if (normalizeTableName(name) === PLUGIN_TABLE) section = 'plugin';
      else if (normalizeTableName(name) === MARKETPLACE_TABLE) section = 'marketplace';
      continue;
    }

    if (section === 'other') continue;
    const parsed = parseQuotedAssignment(line);
    if (!parsed) continue;
    if (section === 'reva') reva[parsed.key] = parsed.value;
    else if (section === 'reva.env') revaEnv[parsed.key] = parsed.value;
    else if (parsed.key === 'auth_token') fallbackToken[section] = parsed.value;
  }

  const debugRaw = pickString(revaEnv.REVA_DEBUG, reva.debug, reva.REVA_DEBUG);

  return {
    authToken: pickString(
      revaEnv.REVA_AUTH_TOKEN,
      reva.auth_token,
      reva.authToken,
      reva.REVA_AUTH_TOKEN,
      fallbackToken.plugin,
      fallbackToken.marketplace,
      fallbackToken.top,
    ),
    host: pickString(revaEnv.REVA_HOST, reva.host, reva.REVA_HOST),
    agentId: pickString(
      revaEnv.REVA_AGENT_ID,
      reva.agent_id,
      reva.agentId,
      reva.REVA_AGENT_ID,
    ),
    debug: isTruthy(debugRaw) || undefined,
  };
}

export function readCodexRevaConfig(configPath?: string): CodexRevaConfig {
  try {
    const raw = fs.readFileSync(codexConfigPath(configPath), 'utf8');
    return parseRevaToml(raw);
  } catch {
    return {};
  }
}
