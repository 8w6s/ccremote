import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { replyV2, v2Panel } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder().setName('claude-help').setDescription('Show the Claude Code to Discord feature map.'),
  async execute(i) {
    await replyV2(i, v2Panel({
      title: 'Claude Code × Discord',
      body: [
        '**Native/session:** `/model` `/effort` `/mode` `/compact` `/clear` `/context` `/usage` `/recap` `/diff` `/doctor` `/init`',
        '**Control:** `/branch` `/sync-sessions` `/loop` `/goal` `/stop` `/task` `/status`',
        '**Mapped UI:** approvals, single/multi AskUserQuestion, Edit/Write diffs, plan approval, tool status/results/errors, retries, rate limits, thinking, subagent threads, tasks, and push DMs.',
        '**Invoke through Claude:** agents, skills, workflows, batch, simplify, review, security review, hooks, and MCP. Ask naturally or use `/skill`.',
        '**Terminal/browser only:** login/logout, IDE, theme, keybindings, clipboard, terminal setup, app installation, privacy, remote-control, and teleport.',
        '-# Claude Code removed `/pr-comments`; ask Claude to read PR comments directly.',
      ].join('\n\n'),
    }), { ephemeral: true });
  },
};
export default command;
