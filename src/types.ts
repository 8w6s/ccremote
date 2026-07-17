import {
  Client,
  Collection,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  ClientEvents,
} from 'discord.js';

export interface ExtendedClient extends Client {
  commands: Collection<string, Command>;
}

export type SlashData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface Command {
  data: SlashData;
  ownerOnly?: boolean;
  execute(interaction: ChatInputCommandInteraction, client: ExtendedClient): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute(...args: ClientEvents[K]): void | Promise<void>;
}
