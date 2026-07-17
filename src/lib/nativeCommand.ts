import { ChatInputCommandInteraction } from 'discord.js';
import { bridge } from './bridge';
import { getSession } from './state';
import { requireSessionChannel } from './sessionGuard';
import { replyV2, v2Error, v2Ok } from './v2';

export async function runNativeCommand(
  interaction: ChatInputCommandInteraction,
  command: string,
  tag: string,
  acknowledgement = 'Command sent to Claude Code; output will appear in this channel.',
): Promise<void> {
  const channel = await requireSessionChannel(interaction);
  if (!channel) return;
  const session = getSession(channel.id);
  if (!session || session.syncing || session.readOnlyImport) {
    await replyV2(interaction, v2Error(session?.syncing
      ? '⚠ Transcript sync is still in progress.'
      : '⚠ This imported session is read-only because its CWD is outside the allowlist.'), { ephemeral: true });
    return;
  }
  const { runner, reason } = await bridge.getOrCreate(channel);
  if (!runner) {
    await replyV2(interaction, v2Error(reason ?? '❌ Runner is unavailable.'), { ephemeral: true });
    return;
  }
  await runner.push(command, [], interaction.user.id, { tag });
  await replyV2(interaction, v2Ok(`✅ ${acknowledgement}`), { ephemeral: true });
}
