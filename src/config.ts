import dotenv from 'dotenv';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

dotenv.config();

/**
 * Runtime configuration for clauderemote.
 * Required: BOT_TOKEN, CLIENT_ID, GUILD_ID, OWNER_ID, HUB_CHANNEL_ID, CATEGORY_ID.
 */

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(
      `⚠ Environment variable ${name}="${raw}" is not positive; using ${fallback}.`,
    );
    return fallback;
  }
  return Math.floor(n);
}

export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  clientId: process.env.CLIENT_ID ?? '',
  guildId: process.env.GUILD_ID ?? '',
  ownerId: process.env.OWNER_ID ?? '',
  hubChannelId: process.env.HUB_CHANNEL_ID ?? '',
  categoryId: process.env.CATEGORY_ID ?? '',
  backgroundCategoryId: process.env.BACKGROUND_CATEGORY_ID ?? '',

  /**
   *
   */
  archiveCategoryId: process.env.ARCHIVE_CATEGORY_ID ?? '',

  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? '',

  defaultCwd: process.env.DEFAULT_CWD || join(homedir(), 'PROJECTS'),
  allowedCwdPrefixes: (process.env.ALLOWED_CWD_PREFIXES || `${join(homedir(), 'PROJECTS')},${tmpdir()}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxPromptsPerHour: parsePositiveInt('MAX_PROMPTS_PER_HOUR', process.env.MAX_PROMPTS_PER_HOUR, 60),

  maxAttachmentBytes: parsePositiveInt(
    'MAX_ATTACHMENT_BYTES',
    process.env.MAX_ATTACHMENT_BYTES,
    25 * 1024 * 1024,
  ),

  // Larger images fall back to path mode so Claude can read them explicitly.
  maxImageBytes: parsePositiveInt(
    'MAX_IMAGE_BYTES',
    process.env.MAX_IMAGE_BYTES,
    5 * 1024 * 1024,
  ),

  maxInlineImages: parsePositiveInt(
    'MAX_INLINE_IMAGES',
    process.env.MAX_INLINE_IMAGES,
    5,
  ),
  maxInlineTextBytes: parsePositiveInt(
    'MAX_INLINE_TEXT_BYTES',
    process.env.MAX_INLINE_TEXT_BYTES,
    256 * 1024,
  ),
  attachmentDownloadTimeoutMs: parsePositiveInt(
    'ATTACHMENT_DOWNLOAD_TIMEOUT_MS',
    process.env.ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
    30_000,
  ),
};

export function validateConfig(): void {
  const required: Array<[string, string]> = [
    ['BOT_TOKEN', config.botToken],
    ['CLIENT_ID', config.clientId],
    ['GUILD_ID', config.guildId],
    ['OWNER_ID', config.ownerId],
    ['HUB_CHANNEL_ID', config.hubChannelId],
    ['CATEGORY_ID', config.categoryId],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Create .env from .env.example and fill in every required value.`,
    );
  }
}
