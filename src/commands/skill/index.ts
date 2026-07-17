import { SlashCommandBuilder, AutocompleteInteraction } from 'discord.js';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

function listSkills(): string[] {
  const dir = join(homedir(), '.claude', 'skills');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

interface SkillCommand extends Command {
  autocomplete(interaction: AutocompleteInteraction): Promise<void>;
}

const command: SkillCommand = {
  data: new SlashCommandBuilder()
    .setName('skill')
    .setDescription('Invoke a Claude Code skill in this session.')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Skill name, with local autocomplete')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('args').setDescription('Args (optional)').setRequired(false),
    ) as unknown as SlashCommandBuilder,
  async autocomplete(interaction) {
    const q = interaction.options.getFocused().toLowerCase();
    const skills = listSkills()
      .filter((s) => !q || s.toLowerCase().includes(q))
      .slice(0, 25)
      .map((s) => ({ name: s, value: s }));
    await interaction.respond(skills).catch(() => {});
  },
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
    const name = interaction.options.getString('name', true);
    const args = interaction.options.getString('args') ?? '';
    const { runner, reason } = await bridge.getOrCreate(channel);
    if (!runner) {
      await replyV2(interaction, v2Error(reason ?? '❌ Unable to start the Runner.'), {
        ephemeral: true,
      });
      return;
    }
    await runner.push(`/${name}${args ? ' ' + args : ''}`, [], interaction.user.id);
    await replyV2(interaction, v2Ok(`▶ Invoked skill \`/${name}\`.`), { ephemeral: true });
  },
};

export default command;
