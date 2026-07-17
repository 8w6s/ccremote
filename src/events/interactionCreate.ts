import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { BotEvent } from '../types';
import { config } from '../config';
import { createSessionChannel } from '../lib/hub';
import { v2Error, v2Info, v2Ok, V2_FLAGS_EPHEMERAL } from '../lib/v2';
import { isAuthorizedUser } from '../lib/authorization';
import { log } from '../lib/logger';
import { ExtendedClient } from '../types';
import { bridge } from '../lib/bridge';
import { getCache, buildRewindPanel } from '../commands/rewind';
import {
  resolveApproval,
  explainApproval,
  getApproval,
  selectQuestionOption,
  selectQuestionOptions,
  setQuestionCustomAnswer,
  setQuestionTab,
  submitQuestionApproval,
  moveQuestion,
  chatAboutQuestion,
  cycleQuestionOptions,
} from '../lib/approvalRegistry';

const event: BotEvent<'interactionCreate'> = {
  name: 'interactionCreate',
  async execute(interaction) {
    if (interaction.guildId !== config.guildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          components: [v2Error('❌ This bot is not configured for this server.')],
          flags: V2_FLAGS_EPHEMERAL,
          allowedMentions: { parse: [] },
        }).catch(() => {});
      }
      return;
    }
    // Auth: owner OR team member.
    if ('user' in interaction && !isAuthorizedUser(interaction.user.id, interaction.channel)) {
      if (interaction.isRepliable()) {
        await interaction
          .reply({
            components: [v2Error('❌ You are not allowed to use this bot.')],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      const client = interaction.client as ExtendedClient;
      const cmd = client.commands.get(interaction.commandName);
      if (cmd && typeof (cmd as unknown as { autocomplete?: unknown }).autocomplete === 'function') {
        try {
          await (cmd as unknown as {
            autocomplete: (i: typeof interaction) => Promise<void>;
          }).autocomplete(interaction);
        } catch (err) {
          log.warn('Autocomplete error:', err instanceof Error ? err.message : err);
        }
      }
      return;
    }

    // Slash command.
    if (interaction.isChatInputCommand()) {
      const client = interaction.client as ExtendedClient;
      const cmd = client.commands.get(interaction.commandName);
      if (!cmd) {
        await interaction
          .reply({
            components: [v2Error(`❌ Unknown command: ${interaction.commandName}`)],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return;
      }
      try {
        await cmd.execute(interaction, client);
      } catch (err) {
        log.err(`Command "${interaction.commandName}" error:`, err);
        const errBody = err instanceof Error ? err.message : String(err);
        const container = v2Error(`❌ Error: \`${errBody}\``);
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({
              components: [container],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        } else {
          await interaction
            .reply({
              components: [container],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        }
      }
      return;
    }

    // Button.
    if (interaction.isButton()) {
      if (interaction.customId === 'cr:new-session') {
        await interaction
          .deferReply({ flags: V2_FLAGS_EPHEMERAL } as never)
          .catch(() => {});
        const result = await createSessionChannel(interaction.client);
        if (!result) {
          await interaction
            .editReply({
              components: [v2Error('❌ Unable to create a session channel.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            } as unknown as Parameters<typeof interaction.editReply>[0])
            .catch(() => {});
          return;
        }
        await interaction
          .editReply({
            components: [v2Ok(`✅ Create new session: <#${result.channelId}>`)],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          } as unknown as Parameters<typeof interaction.editReply>[0])
          .catch(() => {});
        return;
      }

      // Rewind paginator: cr:rewind:page:<cacheKey>:<pageIdx>
      if (interaction.customId.startsWith('cr:rewind:page:')) {
        const rest = interaction.customId.slice('cr:rewind:page:'.length);
        const lastColon = rest.lastIndexOf(':');
        const cacheK = rest.slice(0, lastColon);
        const page = parseInt(rest.slice(lastColon + 1), 10);
        const entry = getCache(cacheK);
        if (!entry) {
          await interaction
            .update({
              components: [v2Error('⚠ Cache expired — run /rewind again.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            } as unknown as Parameters<typeof interaction.update>[0])
            .catch(() => {});
          return;
        }
        await interaction
          .update({
            components: [buildRewindPanel(cacheK, entry.prompts, page)],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          } as unknown as Parameters<typeof interaction.update>[0])
          .catch(() => {});
        return;
      }

      // Approval button: cr:appr:<requestId>:<action>[:<extra>]
      if (interaction.customId.startsWith('cr:appr:')) {
        const rest = interaction.customId.slice('cr:appr:'.length);
        const parts = rest.split(':');
        const requestId = parts[0] ?? '';
        const action = parts[1] ?? '';

        if (action === 'qopt') {
          const ok = await selectQuestionOption(
            requestId,
            Number(parts[2]),
            Number(parts[3]),
          );
          if (ok) await interaction.deferUpdate().catch(() => {});
          else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
          return;
        }

        if (action === 'qsubmit') {
          const ok = await submitQuestionApproval(requestId);
          if (ok) await interaction.deferUpdate().catch(() => {});
          else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
          return;
        }

        if (action === 'qprev' || action === 'qnext') {
          const ok = await moveQuestion(requestId, action === 'qprev' ? -1 : 1);
          if (ok) await interaction.deferUpdate().catch(() => {});
          else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
          return;
        }

        if (action === 'qmore') {
          const ok = await cycleQuestionOptions(requestId);
          if (ok) await interaction.deferUpdate().catch(() => {});
          else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
          return;
        }

        if (action === 'qother') {
          const questionIndex = Number(parts[2]);
          const modal = new ModalBuilder()
            .setCustomId(`cr:appr:${requestId}:qothermodal:${questionIndex}`)
            .setTitle('Type your answer');
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('answer')
              .setLabel('Answer')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true),
          ));
          await interaction.showModal(modal).catch(() => {});
          return;
        }


        if (action === 'qchat') {
          const modal = new ModalBuilder()
            .setCustomId(`cr:appr:${requestId}:qchatmodal`)
            .setTitle('Chat about this question');
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('message')
              .setLabel('What should Claude discuss?')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true),
          ));
          await interaction.showModal(modal).catch(() => {});
          return;
        }

        if (action === 'explain') {
          const detail = await explainApproval(requestId);
          await interaction
            .reply({
              components: [
                detail
                  ? v2Info(`## ❓ Explain\n${detail}`)
                  : v2Error('⚠ This approval is no longer pending.'),
              ],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }

        if (action === 'amend') {
          const approval = getApproval(requestId);
          if (!approval) {
            await interaction
              .reply({
                components: [v2Error('⚠ This approval is no longer pending.')],
                flags: V2_FLAGS_EPHEMERAL,
                allowedMentions: { parse: [] },
              })
              .catch(() => {});
            return;
          }
          const currentCmd =
            typeof approval.input.command === 'string'
              ? approval.input.command
              : JSON.stringify(approval.input);
          const modal = new ModalBuilder()
            .setCustomId(`cr:appr:${requestId}:amendmodal`)
            .setTitle('Amend tool input');
          const input = new TextInputBuilder()
            .setCustomId('cmd')
            .setLabel(
              approval.toolName === 'Bash' ? 'Command' : `Input JSON for ${approval.toolName}`,
            )
            .setStyle(TextInputStyle.Paragraph)
            .setValue(currentCmd.slice(0, 4000))
            .setRequired(true);
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(input),
          );
          await interaction.showModal(modal).catch(() => {});
          return;
        }

        // yes / always / no / cancel
        const ok = await resolveApproval(requestId, action);
        if (!ok) {
          await interaction
            .reply({
              components: [v2Error('⚠ This approval is no longer pending or has already been resolved.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }
        // Ack silent.
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      // Thinking expand: cr:think:<id>
      if (interaction.customId.startsWith('cr:think:')) {
        const id = interaction.customId.slice('cr:think:'.length);
        const runner = bridge.getRunnerForChannel(interaction.channelId ?? '');
        const full = runner?.getRenderer().getThinking(id);
        if (!full) {
          await interaction
            .reply({
              components: [v2Error('⚠ Thinking cache expired after a restart or timeout.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }
        const rawBody = full.length > 3800 ? full.slice(0, 3800) + '…' : full;
        const body = rawBody.replace(/```/g, '`​`​`');
        await interaction
          .reply({
            components: [v2Info(`## ✻ Thinking (full)\n\`\`\`\n${body}\n\`\`\``)],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return;
      }
    }

    // Modal submit — approval amend.
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('cr:appr:') && interaction.customId.endsWith(':qchatmodal')) {
        const requestId = interaction.customId.slice('cr:appr:'.length).replace(/:qchatmodal$/, '');
        const ok = await chatAboutQuestion(requestId, interaction.fields.getTextInputValue('message'));
        await interaction.reply({
          components: [ok ? v2Ok('✅ Sent back to Claude as a discussion request.') : v2Error('⚠ This form is no longer pending.')],
          flags: V2_FLAGS_EPHEMERAL,
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('cr:appr:') && interaction.customId.includes(':qothermodal:')) {
        const rest = interaction.customId.slice('cr:appr:'.length);
        const marker = ':qothermodal:';
        const at = rest.lastIndexOf(marker);
        const requestId = rest.slice(0, at);
        const questionIndex = Number(rest.slice(at + marker.length));
        const ok = await setQuestionCustomAnswer(
          requestId,
          questionIndex,
          interaction.fields.getTextInputValue('answer'),
        );
        await interaction.reply({
          components: [ok ? v2Ok('✅ Answer saved.') : v2Error('⚠ This form is no longer pending.')],
          flags: V2_FLAGS_EPHEMERAL,
          allowedMentions: { parse: [] },
        }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('cr:appr:') && interaction.customId.endsWith(':amendmodal')) {
        const rest = interaction.customId.slice('cr:appr:'.length);
        const requestId = rest.replace(/:amendmodal$/, '');
        const approval = getApproval(requestId);
        if (!approval) {
          await interaction
            .reply({
              components: [v2Error('⚠ This approval is no longer pending.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }
        const newVal = interaction.fields.getTextInputValue('cmd');
        let amendedInput: Record<string, unknown>;
        if (approval.toolName === 'Bash') {
          amendedInput = { ...approval.input, command: newVal };
        } else {
          try {
            amendedInput = JSON.parse(newVal);
          } catch {
            await interaction
              .reply({
                components: [v2Error('❌ Input is not valid JSON.')],
                flags: V2_FLAGS_EPHEMERAL,
                allowedMentions: { parse: [] },
              })
              .catch(() => {});
            return;
          }
        }
        await resolveApproval(requestId, 'yes', amendedInput);
        await interaction
          .reply({
            components: [v2Ok('✅ Changes applied and approved.')],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return;
      }
    }

    // String-select interactions for questions and rewind navigation.
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith('cr:appr:qpick:')) {
        const rest = interaction.customId.slice('cr:appr:qpick:'.length);
        const at = rest.lastIndexOf(':');
        const requestId = rest.slice(0, at);
        const questionIndex = Number(rest.slice(at + 1));
        const ok = await selectQuestionOptions(
          requestId,
          questionIndex,
          interaction.values.map(Number),
        );
        if (ok) await interaction.deferUpdate().catch(() => {});
        else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('cr:appr:qtab:')) {
        const requestId = interaction.customId.slice('cr:appr:qtab:'.length);
        const ok = await setQuestionTab(requestId, Number(interaction.values[0]));
        if (ok) await interaction.deferUpdate().catch(() => {});
        else await interaction.reply({ components: [v2Error('⚠ This form is no longer pending.')], flags: V2_FLAGS_EPHEMERAL }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('cr:rewind:pick:')) {
        // customId = cr:rewind:pick:<cacheK>:<page>
        const rest = interaction.customId.slice('cr:rewind:pick:'.length);
        const lastColon = rest.lastIndexOf(':');
        const cacheK = rest.slice(0, lastColon);
        const entry = getCache(cacheK);
        if (!entry) {
          await interaction
            .reply({
              components: [v2Error('⚠ Cache expired — run /rewind again.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }
        const idx = parseInt(interaction.values[0] ?? '', 10);
        const prompt = entry.prompts[idx];
        if (!prompt) {
          await interaction
            .reply({
              components: [v2Error('⚠ Prompt not found.')],
              flags: V2_FLAGS_EPHEMERAL,
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
          return;
        }
        const rawBody =
          prompt.text.length > 3800 ? prompt.text.slice(0, 3800) + '…' : prompt.text;
        const body = rawBody.replace(/```/g, '`​`​`');
        await interaction
          .reply({
            components: [
              v2Info(`## ⏪ Prompt #${prompt.index + 1}\n\`\`\`\n${body}\n\`\`\``),
            ],
            flags: V2_FLAGS_EPHEMERAL,
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return;
      }
    }
  },
};

export default event;
