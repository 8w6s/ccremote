import {
  SlashCommandBuilder,
  ContainerBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { Command } from '../../types';
import { v2Error, replyV2, V2_FLAGS_EPHEMERAL } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { readUserPrompts, UserPrompt } from '../../lib/rewind';

const REWIND_ACCENT = 0x9b8adf;
const PAGE_SIZE = 25;
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  channelId: string;
  prompts: UserPrompt[];
  createdAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(channelId: string, sessionUuid: string): string {
  return `${channelId}:${sessionUuid}`;
}

export function getCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e;
}

function setCache(key: string, e: CacheEntry): void {
  cache.set(key, e);
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function td(text: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(text.slice(0, 4000));
}

/**
 */
export function buildRewindPanel(
  cacheK: string,
  prompts: UserPrompt[],
  page: number,
): ContainerBuilder {
  const totalPages = Math.max(1, Math.ceil(prompts.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = clampedPage * PAGE_SIZE;
  const slice = prompts.slice(start, start + PAGE_SIZE);

  const c = new ContainerBuilder().setAccentColor(REWIND_ACCENT);
  c.addTextDisplayComponents(
    td(`## ⏪ Rewind — ${prompts.length} prompts · trang ${clampedPage + 1}/${totalPages}`),
  );
  c.addTextDisplayComponents(
    td('-# Select a prompt to view its content. This panel is ephemeral.'),
  );

  if (slice.length === 0) {
    c.addTextDisplayComponents(td('_(no prompts yet — send a few messages and try again)_'));
    return c;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`cr:rewind:pick:${cacheK}:${clampedPage}`)
    .setPlaceholder(`${slice.length} prompts on this page`)
    .addOptions(
      slice.map((p) => {
        const label = truncate(p.text.replace(/\s+/g, ' '), 95);
        return new StringSelectMenuOptionBuilder()
          .setLabel(label || `#${p.index}`)
          .setValue(String(p.index))
          .setDescription(`#${p.index + 1}`);
      }),
    );
  c.addActionRowComponents(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  );

  if (totalPages > 1) {
    const prev = new ButtonBuilder()
      .setCustomId(`cr:rewind:page:${cacheK}:${clampedPage - 1}`)
      .setLabel('◀ Previous page')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage === 0);
    const next = new ButtonBuilder()
      .setCustomId(`cr:rewind:page:${cacheK}:${clampedPage + 1}`)
      .setLabel('Next page ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage >= totalPages - 1);
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next),
    );
  }

  return c;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('rewind')
    .setDescription('Browse prompts previously sent in this session.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    if (!session.sessionUuid) {
      await replyV2(interaction, v2Error('❌ This session has no UUID yet — send a prompt and try again.'), {
        ephemeral: true,
      });
      return;
    }
    const prompts = readUserPrompts(session.cwd, session.sessionUuid);
    if (prompts.length === 0) {
      await replyV2(
        interaction,
        v2Error('⚠ No prompts were found in this session, or its JSONL does not exist.'),
        { ephemeral: true },
      );
      return;
    }
    const key = cacheKey(channel.id, session.sessionUuid);
    setCache(key, { channelId: channel.id, prompts, createdAt: Date.now() });
    const panel = buildRewindPanel(key, prompts, prompts.length > PAGE_SIZE
      ? Math.floor((prompts.length - 1) / PAGE_SIZE)
      : 0);
    await interaction.reply({
      components: [panel],
      flags: V2_FLAGS_EPHEMERAL,
      allowedMentions: { parse: [] },
    });
  },
};

export default command;
