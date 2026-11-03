import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  isMachineId,
  osFamily,
  readOsHardwareId,
  readSavedMachineId,
  resetMachineIdCacheForTests,
  resolveMachineId,
  saveMachineId,
} from '../src/deviceId';

const GUID = 'c4acf3b4-e1c8-4ed3-bb02-36798ec7e672';
const LINUX_ID = '0123456789abcdef0123456789abcdef';

function tempDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-device-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fresh(t: any): void {
  resetMachineIdCacheForTests();
  t.after(resetMachineIdCacheForTests);
}

test('isMachineId accepts a GUID or 32 hex chars, nothing else', () => {
  assert.ok(isMachineId(GUID));
  assert.ok(isMachineId(GUID.toUpperCase()));
  assert.ok(isMachineId(LINUX_ID));
  for (const bad of [undefined, '', 'machine-abc', GUID.slice(1), `${GUID}x`, 'z'.repeat(32)]) {
    assert.ok(!isMachineId(bad), `${bad} must be rejected`);
  }
});

test('the OS hardware id, when available, is a real machine id', () => {
  const id = readOsHardwareId();
  if (id !== undefined) assert.ok(isMachineId(id), `unexpected OS id shape: ${id}`);
});

test('resolveMachineId returns the OS id and saves it for later hooks', (t) => {
  const dir = tempDir(t);
  fresh(t);
  assert.equal(resolveMachineId(dir, () => GUID), GUID);
  assert.equal(fs.readFileSync(path.join(dir, 'machine-id'), 'utf8'), GUID);
});

test('a saved id is reused without reading the OS again', (t) => {
  const dir = tempDir(t);
  fresh(t);
  saveMachineId(dir, GUID);
  assert.equal(
    resolveMachineId(dir, () => {
      throw new Error('the OS must not be read when a saved id exists');
    }),
    GUID,
  );
});

test('a failed OS read returns undefined — never an invented id — and is not cached', (t) => {
  const dir = tempDir(t);
  fresh(t);
  assert.equal(resolveMachineId(dir, () => undefined), undefined);
  assert.equal(resolveMachineId(dir, () => 'not-a-machine-id'), undefined);
  assert.ok(!fs.existsSync(path.join(dir, 'machine-id')), 'nothing is saved on failure');
  // The next call retries rather than reusing the failure.
  assert.equal(resolveMachineId(dir, () => GUID), GUID);
});

test('an old random device-id file is never used', (t) => {
  const dir = tempDir(t);
  fresh(t);
  fs.writeFileSync(path.join(dir, 'device-id'), 'ac010c5a-f760-447a-9031-0085bb249619');
  assert.equal(resolveMachineId(dir, () => undefined), undefined);
});

test('a malformed saved machine-id file is ignored and the OS is read', (t) => {
  const dir = tempDir(t);
  fresh(t);
  fs.writeFileSync(path.join(dir, 'machine-id'), 'garbage');
  assert.equal(readSavedMachineId(dir), undefined);
  assert.equal(resolveMachineId(dir, () => LINUX_ID), LINUX_ID);
});

test('without a data directory nothing is read or saved, but the OS id is still returned', (t) => {
  fresh(t);
  assert.equal(readSavedMachineId(undefined), undefined);
  saveMachineId(undefined, GUID); // no-op, must not throw
  assert.equal(resolveMachineId(undefined, () => GUID), GUID);
});

test('an unwritable directory still returns the OS id for this run', (t) => {
  fresh(t);
  const bad = path.join(os.tmpdir(), 'reva-device-\0invalid');
  assert.equal(resolveMachineId(bad, () => GUID), GUID);
});

test('resolveMachineId is stable within a process', (t) => {
  const dir = tempDir(t);
  fresh(t);
  const first = resolveMachineId(dir);
  assert.equal(resolveMachineId(dir), first);
});

test('osFamily normalizes the known platforms and passes others through', () => {
  // Policy-visible strings: a Cedar policy matching "windows" depends on these.
  assert.equal(osFamily('win32'), 'windows');
  assert.equal(osFamily('darwin'), 'macos');
  assert.equal(osFamily('linux'), 'linux');
  // Unrecognized platforms are reported as-is rather than bucketed wrongly.
  assert.equal(osFamily('freebsd' as NodeJS.Platform), 'freebsd');
});

test('osFamily on this machine returns a non-empty family', () => {
  assert.ok(osFamily().length > 0);
});

test('the machine id is NOT the Agent id — they are separate concepts', (t) => {
  // A hardware-rooted Agent would fragment one human into a separate Agent
  // entity per machine. This resolver's only consumer is
  // User.registeredMachineIds (and context.machineId); the Agent comes from
  // readCodexAccountId(), which has no fallback at all.
  const dir = tempDir(t);
  fresh(t);
  const machineId = resolveMachineId(dir);
  if (machineId !== undefined) assert.ok(isMachineId(machineId));
});
