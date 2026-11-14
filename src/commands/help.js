import { ComponentType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getLogoFiles } from '../utils/embeds.js';
import {
  HELP_SELECT_CUSTOM_ID,
  buildDynamicHelpEmbed,
  buildHelpCategoryMenu,
  discoverHelpEntries,
} from '../services/helpService.js';

const HELP_MENU_TIMEOUT_MS = 60_000;

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Tampilkan panduan penggunaan command dan aturan permainan Midwave');

/**
 * Executes the `/help` and `!help` command with dynamic discovery and optional category filter.
 * @param {import('discord.js').ChatInputCommandInteraction | import('../handlers/MessageCommandAdapter.js').MessageCommandAdapter} interaction
 * @param {object} [context]
 */
export async function execute(interaction, context = {}) {
  const prefix =
    typeof context?.prefix === 'string' && context.prefix.trim() ? context.prefix.trim() : '!';
  const memberPermissions =
    interaction?.memberPermissions ?? interaction?.member?.permissions ?? null;

  const discoverOptions = {
    commandHandler: context?.commandHandler ?? null,
    memberPermissions,
    prefix,
  };
  if (context?.commandStructure) {
    discoverOptions.commandStructure = context.commandStructure;
  }
  if (context?.handlerRegistry) {
    discoverOptions.handlerRegistry = context.handlerRegistry;
  }
  if (context?.registeredPrefixCommands) {
    discoverOptions.registeredPrefixCommands = context.registeredPrefixCommands;
  }

  const entries = discoverHelpEntries(discoverOptions);
  let currentCategory = 'all';

  const initialEmbed = buildDynamicHelpEmbed({
    entries,
    categoryKey: currentCategory,
    prefix,
  });
  const initialRow = buildHelpCategoryMenu({ selectedCategory: currentCategory });

  const replyResult = await interaction.reply({
    embeds: [initialEmbed],
    files: getLogoFiles(),
    components: [initialRow],
    allowedMentions: { parse: [], repliedUser: false },
  });

  let replyMsg = replyResult;
  if (
    (!replyMsg || typeof replyMsg.createMessageComponentCollector !== 'function') &&
    typeof interaction.fetchReply === 'function'
  ) {
    replyMsg = await interaction.fetchReply().catch(() => null);
  }

  if (!replyMsg || typeof replyMsg.createMessageComponentCollector !== 'function') {
    return;
  }

  const ownerId = interaction.user?.id ?? null;
  const collector = replyMsg.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: HELP_MENU_TIMEOUT_MS,
  });

  collector.on('collect', async (selectInteraction) => {
    if (selectInteraction.customId && selectInteraction.customId !== HELP_SELECT_CUSTOM_ID) {
      return;
    }

    if (ownerId && selectInteraction.user?.id !== ownerId) {
      await selectInteraction
        .reply({
          content: 'Menu bantuan ini hanya dapat digunakan oleh pengguna yang memanggil command.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    currentCategory = selectInteraction.values?.[0] || 'all';
    const updatedEmbed = buildDynamicHelpEmbed({
      entries,
      categoryKey: currentCategory,
      prefix,
    });
    const updatedRow = buildHelpCategoryMenu({ selectedCategory: currentCategory });

    await selectInteraction.update({
      embeds: [updatedEmbed],
      components: [updatedRow],
    });
  });

  collector.on('end', async () => {
    const disabledRow = buildHelpCategoryMenu({
      selectedCategory: currentCategory,
      disabled: true,
    });

    if (typeof replyMsg.edit === 'function') {
      await replyMsg.edit({ components: [disabledRow] }).catch(() => {});
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    }
  });
}

export default { data, execute };
