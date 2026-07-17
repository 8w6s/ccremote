import { EmbedBuilder, ColorResolvable } from 'discord.js';

export const BRAND_COLOR = 0x9b7cf7;
const OK = 0x77dd77;
const ERR = 0xff6961;

export function baseEmbed(): EmbedBuilder {
  return new EmbedBuilder().setColor(BRAND_COLOR).setFooter({ text: 'clauderemote' });
}

export function okEmbed(description: string): EmbedBuilder {
  return baseEmbed().setColor(OK as ColorResolvable).setDescription(description);
}

export function errorEmbed(description: string): EmbedBuilder {
  return baseEmbed().setColor(ERR as ColorResolvable).setDescription(description);
}
