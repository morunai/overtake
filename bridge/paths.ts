import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Root of all Overtake runtime state. Overridable for tests (OVERTAKE_HOME). */
export function overtakeHome(): string {
  return process.env.OVERTAKE_HOME || join(homedir(), '.overtake');
}

export function paths(home = overtakeHome()) {
  return {
    home,
    run: join(home, 'run'),
    socket: join(home, 'run', 'broker.sock'),
    token: join(home, 'token'),
    logs: join(home, 'logs'),
    brokerLog: join(home, 'logs', 'broker.log'),
  };
}

/** Create the state directories with owner-only permissions. */
export function ensureHome(home = overtakeHome()) {
  const p = paths(home);
  for (const d of [p.home, p.run, p.logs]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
  return p;
}

/** Read the shared secret, creating it (0600) if missing. */
export function readOrCreateToken(home = overtakeHome()): string {
  const p = ensureHome(home);
  if (!existsSync(p.token)) {
    writeFileSync(p.token, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  }
  const mode = statSync(p.token).mode & 0o777;
  if (mode & 0o077) chmodSync(p.token, 0o600);
  return readFileSync(p.token, 'utf8').trim();
}

export function readToken(home = overtakeHome()): string | null {
  try {
    return readFileSync(paths(home).token, 'utf8').trim();
  } catch {
    return null;
  }
}
