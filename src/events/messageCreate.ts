import { ChannelType, TextChannel, ThreadChannel } from 'discord.js';
import { BotEvent } from '../types';
import { config } from '../config';
import { getSession, reopenSession, updateSessionType } from '../lib/state';
import { moveToActive, renameSessionChannel } from '../lib/hub';
import { bridge } from '../lib/bridge';
import { v2Error, V2_FLAGS } from '../lib/v2';
import { fetchReplyContext } from '../lib/replyContext';
import { downloadAttachments, DownloadResult } from '../lib/attachments';
import { isTeamMember } from '../lib/team';
import { normalizeDiscordRequest } from '../lib/inputNormalizer';
import { isKnownSessionCategory, isLiveSessionCategory } from '../lib/sessionCategories';

const event: BotEvent<'messageCreate'> = {
  name: 'messageCreate',
  async execute(message) {
    if (message.author.bot) return;
    if (!message.inGuild()) return;
    if (message.guildId !== config.guildId) return;

    if (message.author.id !== config.ownerId && !isTeamMember(message.author.id)) return;

    const ch = message.channel;

    // A session channel is a mapped GuildText in the active/archive category.
    let sessionChannel: TextChannel | null = null;
    if (ch.type === ChannelType.GuildText) {
      const text = ch as TextChannel;
      const mapped = getSession(text.id);
      if (!mapped) return;
      if (mapped.status !== 'closed' && !isKnownSessionCategory(text.parentId, {
        active: config.categoryId,
        background: config.backgroundCategoryId,
        archive: config.archiveCategoryId,
      })) return;
      sessionChannel = text;
    } else if (
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread
    ) {
      const thread = ch as ThreadChannel;
      const parent = thread.parent;
      if (!parent || parent.type !== ChannelType.GuildText) return;
      if (!isLiveSessionCategory((parent as TextChannel).parentId, {
        active: config.categoryId,
        background: config.backgroundCategoryId,
      })) return;
      sessionChannel = parent as TextChannel;
    } else {
      return;
    }

    let session = getSession(sessionChannel.id);
    if (!session) return;

    if (session.syncing) {
      await sessionChannel.send({
        components: [v2Error('⏳ Transcript sync is in progress; wait for completion before sending a prompt.')],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (session.deleting) {
      await sessionChannel.send({
        components: [v2Error('⚠ This session has an incomplete deletion operation. Retry `/delete confirm:true`.')],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (session.readOnlyImport) {
      await sessionChannel.send({
        components: [v2Error('🔒 This imported session is read-only because its CWD is outside ALLOWED_CWD_PREFIXES.')],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (session.status === 'closed') {
      if (session.channelDeleted) {
        return;
      }
      const moved = await moveToActive(sessionChannel);
      if (!moved) {
        await sessionChannel.send({
          components: [v2Error('❌ Unable to move the session to the active category.')],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const ok = reopenSession(sessionChannel.id);
      if (ok) {
        updateSessionType(sessionChannel.id, 'foreground');
        session = getSession(sessionChannel.id);
        await renameSessionChannel(sessionChannel, '').catch(() => {});
        await sessionChannel.send({
          components: [v2Error('🔓 Session reopened and moved to the active category.')],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
      }
    }
    if (!session) return;

    let replyContext: string | null = null;
    let inlineImages: Array<{ base64: string; mediaType: string }> = [];
    let downloaded: DownloadResult = {
      paths: [], images: [], inlineTexts: [], files: [], rejected: [],
    };

    if (message.reference?.messageId) {
      const quoted = await fetchReplyContext(message);
      if (quoted) {
        replyContext = quoted;
      }
    }

    if (message.attachments.size > 0) {
      downloaded = await downloadAttachments(
        message.attachments,
        session.sessionUuid ?? sessionChannel.id,
        message.id,
      );
      inlineImages = downloaded.images.map((i) => ({
        base64: i.base64,
        mediaType: i.mediaType,
      }));
      if (downloaded.rejected.length > 0) {
        const rej = downloaded.rejected
          .map((r) => `\`${r.name}\` — ${r.reason}`)
          .join(', ');
        await sessionChannel.send({
          components: [v2Error(`⚠ File rejected: ${rej}`)],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
      }
    }

    const normalized = normalizeDiscordRequest({
      content: message.content,
      replyContext,
      inlineAttachments: downloaded.inlineTexts,
      fileAttachments: downloaded.files,
      hasInlineImages: inlineImages.length > 0,
      stickerCount: message.stickers.size,
      sourceMessageId: message.id,
      channelId: sessionChannel.id,
      sessionUuid: session.sessionUuid,
    });
    if (!normalized) return;

    if (!bridge.checkRateLimit(sessionChannel.id, config.maxPromptsPerHour)) {
      await sessionChannel.send({
        components: [v2Error(`⚠ Rate limit exceeded: ${config.maxPromptsPerHour}/h. Please wait.`)],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const { runner, reason } = await bridge.getOrCreate(sessionChannel);
    if (!runner) {
      await sessionChannel.send({
        components: [v2Error(reason ?? '❌ Unable to start the Runner. Check the logs.')],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await runner.push(normalized.text, inlineImages, message.author.id);
    await message.delete().catch(() => {});
  },
};

export default event;
