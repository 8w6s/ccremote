import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { changeSessionCwd } from '../cwd';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('cd')
    .setDescription('Change the session working directory within allowed prefixes.')
    .addStringOption((option) =>
      option
        .setName('path')
        .setDescription('Absolute path')
        .setRequired(true),
    ) as unknown as SlashCommandBuilder,
  execute: changeSessionCwd,
};

export default command;
