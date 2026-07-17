import { Collection, Attachment } from 'discord.js';
import {
  mkdirSync,
  createWriteStream,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { log } from './logger';
import { resolveAllowedCwd } from './pathPolicy';

export const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export interface InlineImage {
  base64: string;
  mediaType: string;
  name: string;
}

export interface DownloadResult {
  /**
   */
  paths: string[];
  images: InlineImage[];
  inlineTexts: Array<{ name: string; text: string; bytes: number }>;
  files: Array<{ name: string; path: string; bytes: number; kind: 'text' | 'binary' }>;
  rejected: Array<{ name: string; reason: string }>;
}

/**
 *
 * Legacy upload cleanup is restricted to canonical allowed cwd roots.
 */
export async function downloadAttachments(
  attachments: Collection<string, Attachment>,
  sessionIdentity: string,
  messageId: string,
): Promise<DownloadResult> {
  const result: DownloadResult = { paths: [], images: [], inlineTexts: [], files: [], rejected: [] };
  const safeSession = sanitize(sessionIdentity);
  const safeMessage = sanitize(messageId);
  const root = resolve(tmpdir(), 'clauderemote');
  const dir = resolve(root, safeSession, safeMessage);
  if (!dir.startsWith(root + sep)) throw new Error('Unsafe attachment temp path');

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.warn('Unable to create attachment temp directory:', err instanceof Error ? err.message : err);
    return result;
  }

  const ts = Date.now();
  let i = 0;
  let inlineImageCount = 0;

  for (const [, att] of attachments) {
    i++;
    const safeName = sanitize(att.name ?? `file${i}${extname(att.url) || ''}`);
    const mediaType = detectMediaType(att, safeName);
    const isImage = mediaType != null && SUPPORTED_IMAGE_TYPES.has(mediaType);

    const overallCap = config.maxAttachmentBytes;
    if (typeof att.size === 'number' && att.size > overallCap) {
      const mb = (att.size / 1024 / 1024).toFixed(1);
      const capMb = (overallCap / 1024 / 1024).toFixed(0);
      result.rejected.push({
        name: safeName,
        reason: `${mb}MB > cap ${capMb}MB`,
      });
      continue;
    }

    const wantInline =
      isImage &&
      inlineImageCount < config.maxInlineImages &&
      (typeof att.size !== 'number' || att.size <= config.maxImageBytes);

    const outPath = buildTempAttachmentPath(sessionIdentity, messageId, safeName, `${ts}-${i}`);
    // Verify that the generated path remains inside the message directory.
    if (!outPath.startsWith(dir + sep) && outPath !== dir) {
      result.rejected.push({ name: safeName, reason: 'path traversal' });
      continue;
    }

    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(config.attachmentDownloadTimeoutMs) });
      if (!res.ok || !res.body) {
        log.warn(`Attachment fetch failed for ${safeName} (${res.status})`);
        result.rejected.push({ name: safeName, reason: `HTTP ${res.status}` });
        continue;
      }
      // Enforce the byte limit while streaming; never trust Content-Length.
      const reader = res.body.getReader();
      const stream = createWriteStream(outPath);
      let bytes = 0;
      let aborted = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          bytes += value.byteLength;
          if (bytes > overallCap) {
            aborted = true;
            break;
          }
          stream.write(Buffer.from(value));
        }
      } finally {
        await new Promise<void>((r) => stream.end(() => r()));
      }
      if (aborted) {
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        result.rejected.push({
          name: safeName,
          reason: `stream exceeds the ${overallCap}-byte limit`,
        });
        continue;
      }

      const downloaded = readFileSync(outPath);
      const decodedText = decodeTextAttachment(downloaded);

      if (wantInline && bytes <= config.maxImageBytes && mediaType) {
        try {
          const base64 = downloaded.toString('base64');
          result.images.push({ base64, mediaType, name: safeName });
          inlineImageCount++;
          unlinkSync(outPath);
        } catch (err) {
          log.warn(
            'Could not encode image as base64; falling back to path mode:',
            err instanceof Error ? err.message : err,
          );
          result.paths.push(outPath);
          result.files.push({ name: safeName, path: outPath, bytes, kind: 'binary' });
          log.dim(`Attachment stored after inline encoding fallback: ${outPath} (${bytes} bytes)`);
        }
      } else if (decodedText !== null && bytes <= config.maxInlineTextBytes) {
        result.inlineTexts.push({ name: safeName, text: decodedText, bytes });
        unlinkSync(outPath);
      } else {
        result.paths.push(outPath);
        const kind = decodedText !== null ? 'text' : 'binary';
        result.files.push({ name: safeName, path: outPath, bytes, kind });
        log.dim(`Attachment stored: ${outPath} (${bytes} bytes, ${kind})`);
        if (isImage && !wantInline) {
          const reasonBits: string[] = [];
          if (inlineImageCount >= config.maxInlineImages) {
            reasonBits.push(`more than ${config.maxInlineImages} inline images`);
          }
          if (typeof att.size === 'number' && att.size > config.maxImageBytes) {
            const mb = (att.size / 1024 / 1024).toFixed(1);
            const capMb = (config.maxImageBytes / 1024 / 1024).toFixed(0);
            reasonBits.push(`${mb}MB > ${capMb}MB inline cap`);
          }
          if (reasonBits.length > 0) {
            log.dim(`Image ${safeName} fallback path-mode: ${reasonBits.join(', ')}`);
          }
        }
      }
    } catch (err) {
      log.warn('Attachment download err:', err instanceof Error ? err.message : err);
      result.rejected.push({
        name: safeName,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  return result;
}

/** Strict-enough text sniffing without trusting Discord MIME or extension. */
export function decodeTextAttachment(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length === 0) return '';
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\r' || char === '\t' || code >= 0x20) printable++;
  }
  return printable / [...text].length >= 0.85 ? text : null;
}

export function sanitizeFilename(name: string): string {
  return sanitize(name);
}

export function buildTempAttachmentPath(
  sessionIdentity: string,
  messageId: string,
  originalName: string,
  prefix = Date.now().toString(),
): string {
  const root = resolve(tmpdir(), 'clauderemote');
  const dir = resolve(root, sanitize(sessionIdentity), sanitize(messageId));
  if (!dir.startsWith(root + sep)) throw new Error('Unsafe attachment temp path');
  return resolve(dir, `${sanitize(prefix)}-${randomUUID().slice(0, 8)}-${sanitize(originalName)}`);
}

export function cleanupTempAttachments(sessionIdentity: string, olderThanMs = 0): number {
  const root = resolve(tmpdir(), 'clauderemote');
  const dir = resolve(root, sanitize(sessionIdentity));
  if (!dir.startsWith(root + sep)) return 0;
  let removed = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (olderThanMs === 0 || stat.mtimeMs < Date.now() - olderThanMs) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    }
    if (olderThanMs === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    return removed;
  }
  return removed;
}

function detectMediaType(att: Attachment, safeName: string): string | null {
  const ct = att.contentType?.split(';')[0]?.trim().toLowerCase();
  if (ct && SUPPORTED_IMAGE_TYPES.has(ct)) return ct;
  // Fallback theo extension.
  const ext = extname(safeName).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

/**
 * Cleanup is allowed only when `_uploads` is inside an allowed cwd root.
 */
export function cleanupUploads(cwd: string, channelId: string, olderThanMs = 0): number {
  const safeCwd = resolveAllowedCwd(cwd);
  if (!safeCwd) return 0;
  const dir = resolve(safeCwd, '_uploads', channelId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (olderThanMs === 0 || st.mtimeMs < cutoff) {
        rmSync(p, { force: true, recursive: false });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return removed;
}

function sanitize(name: string): string {
  return (
    name
      // Strip path separators + control chars.
      .replace(/[/\\\x00-\x1f]/g, '_')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 80) || 'file'
  );
}
