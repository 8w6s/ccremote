import { SlashCommandBuilder } from 'discord.js';
import { spawn } from 'node:child_process';
import { Command } from '../../types';
import { v2Error, replyV2, v2Info, followUpV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';

const SUBS = ['status', 'diff', 'log', 'branch'] as const;
type Sub = (typeof SUBS)[number];

const SUB_ARGS: Record<Sub, string[]> = {
  status: ['status', '--short', '--branch'],
  diff: ['diff', '--stat'],
  log: ['log', '--oneline', '-n', '20', '--decorate'],
  branch: ['branch', '--sort=-committerdate', '--list'],
};

function runGit(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let out = '';
    const append = (value: Buffer | string): void => {
      if (out.length >= 1024 * 1024) return;
      out = (out + value.toString()).slice(0, 1024 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => resolve({ code: code ?? 0, out }));
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
  });
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('git')
    .setDescription('Run a native Git command without using a Claude turn.')
    .addStringOption((o) =>
      o
        .setName('cmd')
        .setDescription('Sub-command')
        .setRequired(true)
        .addChoices(...SUBS.map((s) => ({ name: s, value: s }))),
    ) as unknown as SlashCommandBuilder,
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
    const sub = interaction.options.getString('cmd', true) as Sub;
    await interaction.deferReply({ ephemeral: false } as never).catch(() => {});
    const { code, out } = await runGit(session.cwd, SUB_ARGS[sub]);
    const body = out.slice(0, 3600);
    await followUpV2(
      interaction,
      v2Info(
        `## 🔧 git ${sub}\n\`\`\`\n${body || '(no output)'}\n\`\`\`\n-# exit ${code} · cwd \`${session.cwd}\``,
      ),
    ).catch(() => {});
  },
};

export default command;
