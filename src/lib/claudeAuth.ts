import { ChildProcess, spawn } from 'node:child_process';
import { setCustomApiActive } from './customApi';

interface LoginProcess {
  child: ChildProcess;
  url: string | null;
  output: string;
  urlReady: Promise<string | null>;
  resolveUrl: (url: string | null) => void;
}

let activeLogin: LoginProcess | null = null;

function oauthEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function findUrl(value: string): string | null {
  return stripAnsi(value).match(/https:\/\/[^\s<>]+/i)?.[0] ?? null;
}

export async function startClaudeLogin(): Promise<{
  url: string | null;
  alreadyRunning: boolean;
}> {
  if (activeLogin) {
    return { url: activeLogin.url ?? await activeLogin.urlReady, alreadyRunning: true };
  }
  let resolveUrl!: (url: string | null) => void;
  const urlReady = new Promise<string | null>((resolve) => { resolveUrl = resolve; });
  const child = spawn('claude', ['auth', 'login'], {
    env: oauthEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const record: LoginProcess = { child, url: null, output: '', urlReady, resolveUrl };
  activeLogin = record;
  let urlSettled = false;
  const settleUrl = (url: string | null): void => {
    if (urlSettled) return;
    urlSettled = true;
    record.url = url;
    resolveUrl(url);
  };
  const onData = (chunk: Buffer | string): void => {
    record.output = (record.output + String(chunk)).slice(-16_000);
    const url = findUrl(record.output);
    if (url) settleUrl(url);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('error', () => {
    settleUrl(null);
    if (activeLogin === record) activeLogin = null;
  });
  child.once('exit', (code) => {
    settleUrl(null);
    if (code === 0) setCustomApiActive(false);
    if (activeLogin === record) activeLogin = null;
  });
  const lifetime = setTimeout(() => {
    if (activeLogin === record) child.kill('SIGTERM');
  }, 10 * 60_000);
  lifetime.unref();
  const discovery = setTimeout(() => settleUrl(null), 15_000);
  discovery.unref();
  return { url: await urlReady, alreadyRunning: false };
}

export function submitClaudeLoginCode(code: string): boolean {
  if (!activeLogin?.child.stdin || activeLogin.child.stdin.destroyed) return false;
  activeLogin.child.stdin.write(`${code.trim()}\n`);
  return true;
}

export async function logoutClaude(): Promise<{ ok: boolean; detail: string }> {
  if (activeLogin) {
    activeLogin.child.kill('SIGTERM');
    activeLogin = null;
  }
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'logout'], {
      env: oauthEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer | string): void => {
      output = (output + stripAnsi(String(chunk))).slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, detail: 'Claude auth logout timed out.' });
    }, 30_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: error.message });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        detail: output.trim() || (code === 0 ? 'Logged out.' : `Claude exited with code ${code}.`),
      });
    });
  });
}
