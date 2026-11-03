import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
// A machine id is either the OS's real id or absent — never invented. An
// earlier version fell back to a persisted random UUID whenever the OS read
// failed (most often a cold-start `reg` timeout), which made one PC show up
// in User.registeredMachineIds as several "devices". The only local state is
// a copy of the real id, saved after the first successful read.
//
// This reports an honest per-device value; it is device-fingerprinting, not
// hardware attestation. A malicious client could still misreport it, so
// "this token can't be used from another machine" has to be enforced in
// Reva's policies, not here.

// The first `reg.exe` of a session was measured at ~2.06 s on Windows (later
// calls ~40 ms), so the old 2000 ms limit timed out on a cold start. 10 s
// leaves ample headroom; the hook's own timeout still bounds a read that
// never returns.
const OS_READ_TIMEOUT_MS = 10000;

// Copy of the real OS id, saved after the first successful read so later
// hooks don't need to run `reg`/`ioreg` again.
const MACHINE_ID_FILE = 'machine-id';

function readMacHardwareId(): string | undefined {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: OS_READ_TIMEOUT_MS,
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
    // Full path, so the read doesn't depend on the hook's PATH.
    const reg = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(
      reg,
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: OS_READ_TIMEOUT_MS, windowsHide: true },
    );
    return out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)?.[1];
  } catch {
    return undefined;
  }
}

// The OS's own machine id: hardware UUID on macOS, /etc/machine-id on Linux,
// MachineGuid on Windows. The only source for resolveMachineId below.
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

// A real OS machine id: a GUID (Windows MachineGuid, macOS IOPlatformUUID)
// or 32 hex chars (Linux machine-id). Anything else is rejected rather than
// sent, which also keeps an old random `device-id` file from ever being read.
export function isMachineId(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
      /^[0-9a-f]{32}$/i.test(value))
  );
}

export function readSavedMachineId(dataDir?: string): string | undefined {
  if (!dataDir) return undefined;
  try {
    const saved = fs.readFileSync(path.join(dataDir, MACHINE_ID_FILE), 'utf8').trim();
    return isMachineId(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

// Best effort — a failed save just means the next hook reads the OS again.
export function saveMachineId(dataDir: string | undefined, id: string): void {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, MACHINE_ID_FILE), id, 'utf8');
  } catch {
    // ignore
  }
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

// Resolves this machine's id for `User.registeredMachineIds` and
// context.machineId: the in-process cache, then the saved copy of the real
// id, then the OS read. Returns undefined when none yields a real id — a
// failure isn't cached, so a later call retries. `readOs` is a test seam.
export function resolveMachineId(
  dataDir?: string,
  readOs: () => string | undefined = readOsHardwareId,
): string | undefined {
  if (cached) return cached;
  const saved = readSavedMachineId(dataDir);
  if (saved) return (cached = saved);
  const id = readOs()?.trim();
  if (!isMachineId(id)) return undefined;
  cached = id;
  saveMachineId(dataDir, id);
  return id;
}

// Test seam only — resolveMachineId memoizes for the life of the process.
export function resetMachineIdCacheForTests(): void {
  cached = undefined;
}
