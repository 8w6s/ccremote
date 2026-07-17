import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const stateDir = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'clauderemote',
);
const lockPath = join(stateDir, 'clauderemote.pid');
let owned = false;

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireInstanceLock(): void {
  try {
    const existingPid = Number(readFileSync(lockPath, 'utf-8').trim());
    if (isAlive(existingPid)) {
      throw new Error(`clauderemote is already running (PID ${existingPid})`);
    }
    unlinkSync(lockPath);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('clauderemote is already running')) throw err;
  }

  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('clauderemote is already starting or running (instance lock is held)');
    }
    throw err;
  }
  try {
    writeFileSync(fd, String(process.pid));
    owned = true;
  } finally {
    closeSync(fd);
  }
}

export function releaseInstanceLock(): void {
  if (!owned) return;
  owned = false;
  try {
    const pid = Number(readFileSync(lockPath, 'utf-8').trim());
    if (pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* stale/missing lock */
  }
}
