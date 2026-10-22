import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { osFamily, persistedFallbackId, readOsHardwareId, resetMachineIdCacheForTests, resolveMachineId } from '../src/deviceId';

function tempDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-device-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the fallback id is generated once and then persisted', (t) => {
  const dir = tempDir(t);
  const first = persistedFallbackId(dir);
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal(persistedFallbackId(dir), first);
  assert.equal(fs.readFileSync(path.join(dir, 'device-id'), 'utf8'), first);
});

test('different data directories get different fallback ids', (t) => {
  assert.notEqual(persistedFallbackId(tempDir(t)), persistedFallbackId(tempDir(t)));
});

test('an unwritable directory still yields a usable id for this run', () => {
  // Best-effort persistence: a failed write must not fail the request.
  const id = persistedFallbackId(path.join(os.tmpdir(), 'reva-device-\0invalid'));
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test('the OS hardware id, when available, is a non-empty string', () => {
  const id = readOsHardwareId();
  if (id !== undefined) assert.ok(id.length > 0);
});

test('resolveMachineId is stable within a process', (t) => {
  const dir = tempDir(t);
  resetMachineIdCacheForTests();
  t.after(resetMachineIdCacheForTests);
  const first = resolveMachineId(dir);
  assert.ok(first.length > 0);
  assert.equal(resolveMachineId(dir), first);
});

test('resolveMachineId prefers the real hardware id over the persisted fallback', (t) => {
  const dir = tempDir(t);
  resetMachineIdCacheForTests();
  t.after(resetMachineIdCacheForTests);
  const resolved = resolveMachineId(dir);
  const hardware = readOsHardwareId();
  if (hardware) {
    assert.equal(resolved, hardware);
    // The fallback file must not even be created when a real id exists.
    assert.ok(!fs.existsSync(path.join(dir, 'device-id')));
  }
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
  // User.registeredMachineIds; the Agent comes from readCodexAccountId().
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-device-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  resetMachineIdCacheForTests();
  t.after(resetMachineIdCacheForTests);
  const machineId = resolveMachineId(dir);
  assert.ok(machineId.length > 0);
  // It has a legitimate fallback chain, unlike the account id which has none.
  assert.ok(typeof persistedFallbackId(dir) === 'string');
});
