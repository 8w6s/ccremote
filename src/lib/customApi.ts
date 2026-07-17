import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerSecret } from './scrubber';

export interface CustomApiConfig {
  active: true;
  baseUrl: string;
  apiKey: string;
  models: { opus: string; sonnet: string; haiku: string };
  updatedAt: number;
}

const SETTINGS_FILE = join(homedir(), '.claude', 'settings.json');
const BACKUP_FILE = `${SETTINGS_FILE}.ccremote.bak`;
const MANAGED_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
] as const;

type Settings = Record<string, unknown> & { env?: Record<string, string> };

function readSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return {};
  const parsed: unknown = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude settings.json must contain an object.');
  }
  return parsed as Settings;
}

function writeSettings(settings: Settings): void {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  if (existsSync(SETTINGS_FILE)) copyFileSync(SETTINGS_FILE, BACKUP_FILE);
  const tmp = `${SETTINGS_FILE}.ccremote.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, SETTINGS_FILE);
  chmodSync(SETTINGS_FILE, 0o600);
}

function validateUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function parseModelIds(raw: string): CustomApiConfig['models'] | null {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 3 && parts.every((part) => !part.includes('='))) {
    return { opus: parts[0], sonnet: parts[1], haiku: parts[2] };
  }
  const keyed = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals <= 0) return null;
    keyed.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim());
  }
  const opus = keyed.get('opus');
  const sonnet = keyed.get('sonnet');
  const haiku = keyed.get('haiku');
  return opus && sonnet && haiku ? { opus, sonnet, haiku } : null;
}

export function saveCustomApi(baseUrl: string, apiKey: string, modelIds: string): CustomApiConfig {
  const normalizedUrl = validateUrl(baseUrl);
  if (!normalizedUrl) throw new Error('Base URL must be an HTTP(S) URL without embedded credentials.');
  if (!apiKey.trim()) throw new Error('API key cannot be empty.');
  const models = parseModelIds(modelIds);
  if (!models) {
    throw new Error('Model IDs must be opus=<id>,sonnet=<id>,haiku=<id> or three comma-separated IDs in that order.');
  }
  const settings = readSettings();
  const env = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
  env.ANTHROPIC_BASE_URL = normalizedUrl;
  env.ANTHROPIC_API_KEY = apiKey.trim();
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku;
  env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
  settings.env = env;
  writeSettings(settings);
  registerSecret(apiKey.trim());
  return { active: true, baseUrl: normalizedUrl, apiKey: apiKey.trim(), models, updatedAt: Date.now() };
}

export function getCustomApi(): CustomApiConfig | null {
  const settings = readSettings();
  const env = settings.env;
  if (!env) return null;
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const apiKey = env.ANTHROPIC_API_KEY;
  const opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const haiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!baseUrl || !apiKey || !opus || !sonnet || !haiku) return null;
  registerSecret(apiKey);
  return {
    active: true,
    baseUrl,
    apiKey,
    models: { opus, sonnet, haiku },
    updatedAt: 0,
  };
}

export function customApiEnvironment(): NodeJS.ProcessEnv {
  const custom = getCustomApi();
  if (!custom) return {};
  return {
    ANTHROPIC_BASE_URL: custom.baseUrl,
    ANTHROPIC_API_KEY: custom.apiKey,
    ANTHROPIC_DEFAULT_OPUS_MODEL: custom.models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: custom.models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: custom.models.haiku,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  };
}

/** Remove only keys managed by /customapi, preserving every other Claude setting. */
export function setCustomApiActive(active: boolean): void {
  if (active) return;
  const settings = readSettings();
  if (!settings.env) return;
  const env = { ...settings.env };
  for (const key of MANAGED_KEYS) delete env[key];
  settings.env = env;
  writeSettings(settings);
}
