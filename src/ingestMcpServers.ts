import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveUserEmail } from './identity';
import { ingestMcpServersFromConfig, resolveEntityTypeIds } from './ingestionClient';
import { resolveDataDir } from './pluginPaths';

// MCP server ingestion — deliberately split out from sessionStart.ts's own
// blocking User/Agent ingestion and run as a detached child process instead.
// Discovery itself is a cheap config.toml read (mcpConfig.ts); *ingesting*
// still means a network call to Reva per newly-discovered server.
//
// cwd arrives via REVA_SESSION_CWD for parity with the other plugins' spawn
// contract; Codex MCP servers live in $CODEX_HOME/config.toml regardless,
// so cwd is unused by ingestMcpServersFromConfig today.
//
// REVA_INVOKED_MCP_SERVER arrives when PreToolUse spawned this pass for a
// server that may not appear in config.toml — merge it into the ingest list.

async function main(): Promise<void> {
  const dataDir = resolveDataDir();

  // What this pass ingests: everything config.toml declares, PLUS the server
  // whose tool just got invoked, when the PreToolUse path spawned us with
  // one. It arrives ALREADY slugged: authorize.ts passes the MCPServer
  // parent id that mapping.ts produced.
  const invoked = process.env.REVA_INVOKED_MCP_SERVER?.trim();
  const extraServers = invoked ? [{ name: invoked }] : [];
  if (invoked) {
    debugLog(`ingestMcpServers: including invoked-but-undiscoverable server "${invoked}"`);
  }

  try {
    const cfg = loadConfig();
    const userEmail = resolveUserEmail();

    const { userEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, dataDir);

    if (!mcpServerEntityTypeId) {
      debugLog('ingestMcpServers: skipped — could not resolve MCPServer entity type id');
    } else {
      await ingestMcpServersFromConfig(
        cfg,
        mcpServerEntityTypeId,
        undefined,
        dataDir,
        userEntityTypeId,
        userEmail,
        extraServers,
      ).catch((err) => debugLog(`ingestMcpServers: ingest MCPServers failed — ${err}`));
    }
  } catch (err: any) {
    debugLog(`ingestMcpServers: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
