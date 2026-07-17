import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../config';

function canonical(path: string): string {
  return realpathSync(resolve(path));
}

export function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function resolveAllowedCwd(input: string): string | null {
  let cwd: string;
  try {
    cwd = canonical(input);
    if (!statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }

  for (const prefix of config.allowedCwdPrefixes) {
    try {
      if (isWithin(cwd, canonical(prefix))) return cwd;
    } catch {
    }
  }
  return null;
}
