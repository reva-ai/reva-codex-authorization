import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from './pluginPaths';

// MACHINE identity — deliberately NOT the Agent's identity.
//
// This resolver answers "which physical machine is this", and its only
// consumer is the `User.registeredMachineIds` Set. The Cedar `Agent` is
// ACCOUNT-scoped and comes from identity.ts's readCodexAccountId(): a
// hardware-rooted Agent would fragment one account into a separate Agent
// entity per machine it logs in from, which is the opposite of what an
// Agent identity should mean.
//
// Keeping the two as two separate functions is the point. Conflating them
// silently corrupts whichever downstream attribute actually needed the
// machine-specific value.
//
// Unlike the account id, a machine id legitimately HAS a fallback chain:
// hardware id -> a locally persisted random id. There is no "real" identity
// being stood in for — an unidentifiable machine is just an unidentifiable
// machine, so a stable local id is an honest answer rather than a
// dishonest stand-in.
//
// This reports an honest per-device value; it is device-fingerprinting, not
// hardware attestation. A malicious client could still misreport it, so
// "this token can't be used from another machine" has to be enforced in
// Reva's policies, not here.

function readMacHardwareId(): string | undefined {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

function readLinuxMachineId(): string | undefined {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(p, 'utf8').trim();
      if (id) return id;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function readWindowsMachineGuid(): string | undefined {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2000 },
    );
    return out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)?.[1];
  } catch {
    return undefined;
  }
}

// Exported directly: the CodingAgent schema's `Agent` entity is
// hardware-rooted by design (mac hardware UUID on macOS, /etc/machine-id on
// Linux, MachineGuid on Windows) — this is the primary source for
// resolveMachineId below, not just an internal fallback.
export function readOsHardwareId(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return readMacHardwareId();
    case 'linux':
      return readLinuxMachineId();
    case 'win32':
      return readWindowsMachineGuid();
    default:
      return undefined;
  }
}

// Used only when no OS-level hardware id is available (unsupported
// platform, sandboxed environment, permission denied, etc). Persisted in
// the plugin data directory when available, which survives plugin updates;
// otherwise falls back to a dotfile in the home directory.
export function persistedFallbackId(dataDir?: string): string {
  const dir = dataDir || resolveDataDir();
  const file = path.join(dir, 'device-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // doesn't exist yet — generate and persist below
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
  } catch {
    // best effort — if persistence fails, this run still gets a usable id,
    // just not a stable one across future runs
  }
  return id;
}

// Normalized OS family for the machine this hook runs on, recorded on the
// Agent entity at session start.
//
// Normalized rather than raw `process.platform` because a policy author
// should not have to know macOS is "darwin" and Windows is "win32". THIS IS
// A POLICY-VISIBLE CHOICE: a Cedar policy matching "windows" breaks if these
// strings change, so they are fixed here and documented in the README.
// Anything unrecognized passes through as-is rather than being bucketed into
// a wrong-but-plausible value.
export function osFamily(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return platform;
  }
}

let cached: string | undefined;

// Resolves this machine's id for `User.registeredMachineIds`: the real
// hardware id first (mac hardware UUID / machine-id / MachineGuid), falling
// back to a persisted random id only when no OS-level hardware id is
// available at all (unsupported platform, sandboxed environment, permission
// denied).
export function resolveMachineId(dataDir?: string): string {
  if (!cached) {
    cached = readOsHardwareId() || persistedFallbackId(dataDir);
  }
  return cached;
}

// Test seam only — resolveMachineId memoizes for the life of the process.
export function resetMachineIdCacheForTests(): void {
  cached = undefined;
}
