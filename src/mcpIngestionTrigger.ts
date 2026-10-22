import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { debugLog } from './debug';
import {
  isMcpDiscoveryDue,
  isMcpInvokeIngestDue,
  isMcpServerKnown,
  recordMcpDiscoveryTriggered,
  recordMcpInvokeIngestTriggered,
} from './ingestionClient';

// Spawns ingestMcpServers.ts as a fully detached, unref'd child. Callers
// (sessionStart.ts, unconditionally every session; authorizePrompt.ts, via
// triggerMcpDiscoveryIfDue below; authorize.ts via
// triggerMcpIngestionForInvokedServer) never wait on it, so however long
// discovery+ingestion takes, or however it fails, cannot block them.
export function spawnMcpIngestion(cwd: string, pluginDataDir?: string, invokedServer?: string): void {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'ingestMcpServers.js')], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        REVA_SESSION_CWD: cwd,
        // The server whose tool was just invoked, when this spawn came from
        // the PreToolUse path. Without it the child only re-reads
        // config.toml, which by definition finds nothing new for a server
        // that lives in no config file.
        ...(invokedServer ? { REVA_INVOKED_MCP_SERVER: invokedServer } : {}),
      },
    });
    child.on('error', (err) => debugLog(`spawnMcpIngestion: spawn error — ${err?.message || String(err)}`));
    child.unref();
  } catch (err: any) {
    debugLog(`spawnMcpIngestion: failed to spawn ingestMcpServers — ${err?.message || String(err)}`);
  }
}

// UserPromptSubmit fires every turn — unlike SessionStart, which always
// triggers a pass once per session, this only re-triggers if it's actually
// due (see ingestionClient.ts's isMcpDiscoveryDue), so an MCP server added
// mid-session is picked up again within ~15 minutes instead of only at the
// next SessionStart. "Due" is recorded before spawning, not after
// completion, so a burst of turns inside that window can't each spawn
// their own overlapping pass.
export function triggerMcpDiscoveryIfDue(
  cwd: string,
  pluginDataDir?: string,
  isDue: (pluginDataDir?: string) => boolean = isMcpDiscoveryDue,
  recordTriggered: (pluginDataDir?: string) => void = recordMcpDiscoveryTriggered,
  spawnIngestion: (cwd: string, pluginDataDir?: string) => void = spawnMcpIngestion,
): void {
  if (!isDue(pluginDataDir)) return;
  recordTriggered(pluginDataDir);
  spawnIngestion(cwd, pluginDataDir);
}

// Ingest-on-invoke: an MCP server whose tool is actually being called, but
// which no discovery pass has ingested yet, gets one triggered immediately
// rather than waiting for the next recheck.
//
// Called from the PreToolUse path, so the ordering matters: the known-name
// check runs first and costs one cached read, the spawn is detached and
// never awaited, and the whole thing is wrapped by its caller. Nothing here
// may block or fail an authorization decision.
export function triggerMcpIngestionForInvokedServer(
  serverName: string,
  cwd: string,
  pluginDataDir?: string,
  isKnown: (name: string, pluginDataDir?: string) => boolean = isMcpServerKnown,
  isDue: (pluginDataDir?: string) => boolean = isMcpInvokeIngestDue,
  recordTriggered: (pluginDataDir?: string) => void = recordMcpInvokeIngestTriggered,
  spawnIngestion: (cwd: string, pluginDataDir?: string, invokedServer?: string) => void = spawnMcpIngestion,
): void {
  if (!serverName) return;
  // Dedup only — "have we already ingested this name", NOT "is it
  // discoverable". The name is handed to the child below and ingested on its
  // own merit, so a server that no config file mentions still gets recorded.
  if (isKnown(serverName, pluginDataDir)) return;
  if (!isDue(pluginDataDir)) return;
  recordTriggered(pluginDataDir);
  spawnIngestion(cwd, pluginDataDir, serverName);
}
