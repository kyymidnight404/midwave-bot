import { MessageFlags } from 'discord.js';
import { execute as executeAi } from '../commands/ai.js';
import { execute as executeDonate } from '../commands/donate.js';
import helpCommand from '../commands/help.js';
import knowledgeCommand from '../commands/knowledge.js';
import { execute as executeAutorole } from '../commands/autorole.js';
import { execute as executeMath } from '../commands/math.js';
import { execute as executeBrat } from '../prefixCommands/brat.js';
import { execute as executeDownload } from '../prefixCommands/download.js';
import { execute as executeLyrics } from '../prefixCommands/lyrics.js';
import { execute as executeQc } from '../prefixCommands/qc.js';
import { execute as executeSay } from '../prefixCommands/say.js';
import { SOCIAL_INTERACTIONS } from '../services/otakuGifsService.js';
import { registerDefaultHandlerRegistry } from '../services/helpService.js';
import { buildErrorEmbed } from '../utils/embeds.js';
import { executeSocialAction } from '../utils/socialCommand.js';

/**
 * Built-in handler registry mapping logical handler keys in `commandStructure.js`
 * to existing Midwave feature executors without duplicating business logic.
 */
export function createDefaultHandlerRegistry() {
  const registry = {
    ai: executeAi,
    autorole: executeAutorole,
    donate: executeDonate,
    help: (interaction, context) => helpCommand.execute(interaction, context),
    knowledge: (interaction, context) => knowledgeCommand.execute(interaction, context),
    math: executeMath,
    'media.qc': executeQc,
    'media.brat': executeBrat,
    'media.lyrics': executeLyrics,
    'media.download': executeDownload,
    download: executeDownload,
    media: async (interaction, context, meta = {}) => {
      const action = meta.actionValue || interaction.options?.getString?.('action', false)?.trim().toLowerCase() || '';
      const subHandlers = {
        qc: executeQc,
        brat: executeBrat,
        lyrics: executeLyrics,
        download: executeDownload,
      };
      const fn = Object.hasOwn(subHandlers, action) ? subHandlers[action] : null;
      if (!fn) {
        await interaction.reply({
          embeds: [
            buildErrorEmbed(
              'Action media tidak valid. Pilih salah satu dari: `qc`, `brat`, `lyrics`, atau `download`.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      return fn(interaction, context);
    },
    social: (interaction, context, meta = {}) => {
      const action = meta.actionValue || interaction.options?.getString?.('action', false) || '';
      return executeSocialAction(interaction, action, context);
    },
    say: executeSay,
  };

  for (const actionKey of Object.keys(SOCIAL_INTERACTIONS)) {
    registry[`social.${actionKey}`] = (interaction, context) =>
      executeSocialAction(interaction, actionKey, context);
  }

  return Object.freeze(registry);
}

export const DEFAULT_HANDLER_REGISTRY = createDefaultHandlerRegistry();
registerDefaultHandlerRegistry(DEFAULT_HANDLER_REGISTRY);

/**
 * Wraps `interaction.options` when a command config maps fixed options,
 * subcommands, or action values to an existing handler expecting standard option getters.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   forcedSubcommand?: string | null,
 *   forcedAction?: string | null,
 *   fixedOptions?: Record<string, any> | null,
 * }} [overrides]
 */
export function createMappedInteraction(interaction, overrides = {}) {
  const { forcedSubcommand = undefined, forcedAction = undefined, fixedOptions = null } = overrides;
  if (forcedSubcommand === undefined && forcedAction === undefined && !fixedOptions) {
    return interaction;
  }

  const baseOptions = interaction.options;
  const patchedOptions = {
    getSubcommand: (required = false) => {
      if (forcedSubcommand !== undefined) {
        if (!forcedSubcommand && required) {
          throw new Error('Subcommand is required.');
        }
        return forcedSubcommand;
      }
      return baseOptions?.getSubcommand?.(required) ?? null;
    },
    getSubcommandGroup: (required = false) => baseOptions?.getSubcommandGroup?.(required) ?? null,
    getString: (name, required = false) => {
      if (fixedOptions && Object.hasOwn(fixedOptions, name)) {
        const val = fixedOptions[name];
        return val == null ? null : String(val);
      }
      if (name === 'action' && forcedAction !== undefined) {
        return forcedAction;
      }
      return baseOptions?.getString?.(name, required) ?? null;
    },
    getInteger: (name, required = false) => {
      if (fixedOptions && Object.hasOwn(fixedOptions, name)) {
        return typeof fixedOptions[name] === 'number' ? fixedOptions[name] : null;
      }
      return baseOptions?.getInteger?.(name, required) ?? null;
    },
    getNumber: (name, required = false) => {
      if (fixedOptions && Object.hasOwn(fixedOptions, name)) {
        return typeof fixedOptions[name] === 'number' ? fixedOptions[name] : null;
      }
      return baseOptions?.getNumber?.(name, required) ?? null;
    },
    getBoolean: (name, required = false) => {
      if (fixedOptions && Object.hasOwn(fixedOptions, name)) {
        return typeof fixedOptions[name] === 'boolean' ? fixedOptions[name] : null;
      }
      return baseOptions?.getBoolean?.(name, required) ?? null;
    },
    getUser: (name, required = false) => baseOptions?.getUser?.(name, required) ?? null,
    getChannel: (name, required = false) => baseOptions?.getChannel?.(name, required) ?? null,
    getRole: (name, required = false) => baseOptions?.getRole?.(name, required) ?? null,
    getAttachment: (name, required = false) => baseOptions?.getAttachment?.(name, required) ?? null,
  };

  return new Proxy(interaction, {
    get(target, prop) {
      if (prop === 'options') {
        return patchedOptions;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Resolves a single executable dispatcher for a configured command entry.
 *
 * @param {object} commandConfig
 * @param {Record<string, Function>} [handlerRegistry]
 * @returns {Function}
 */
export function resolveCommandExecutor(commandConfig, handlerRegistry = DEFAULT_HANDLER_REGISTRY) {
  const type = String(commandConfig?.type || 'standalone').toLowerCase();

  return async function executeConfiguredCommand(interaction, context = {}) {
    if (type === 'choice') {
      const actionOptionName = commandConfig.actionOptionName || 'action';
      const rawAction = interaction.options?.getString?.(actionOptionName, false) ?? '';
      const actionValue = typeof rawAction === 'string' ? rawAction.trim().toLowerCase() : '';
      const mappedKey = commandConfig.actionHandlers?.[actionValue] ?? commandConfig.handler;
      const fn = mappedKey && Object.hasOwn(handlerRegistry, mappedKey) ? handlerRegistry[mappedKey] : null;

      if (!fn) {
        await interaction.reply({
          embeds: [buildErrorEmbed(`Action \`${actionValue || '(kosong)'}\` tidak memiliki handler yang valid.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const wrapped = createMappedInteraction(interaction, {
        forcedSubcommand: actionValue,
        forcedAction: actionValue,
        fixedOptions: commandConfig.fixedOptions,
      });
      return fn(wrapped, context, { commandConfig, actionValue });
    }

    if (type === 'subcommand' || type === 'grouped') {
      const groupName = interaction.options?.getSubcommandGroup?.(false) ?? null;
      const subName = interaction.options?.getSubcommand?.(false) ?? '';

      let matchedSub = null;
      if (groupName && Array.isArray(commandConfig.groups)) {
        const groupCfg = commandConfig.groups.find((g) => g.name === groupName);
        matchedSub = groupCfg?.subcommands?.find((s) => s.name === subName) ?? null;
      } else if (Array.isArray(commandConfig.subcommands)) {
        matchedSub = commandConfig.subcommands.find((s) => s.name === subName) ?? null;
      }

      const handlerKey = matchedSub?.handler ?? commandConfig.handler;
      const fn = handlerKey && Object.hasOwn(handlerRegistry, handlerKey) ? handlerRegistry[handlerKey] : null;

      if (!fn) {
        await interaction.reply({
          embeds: [
            buildErrorEmbed(
              `Subcommand \`${[groupName, subName].filter(Boolean).join(' ') || '(tidak diketahui)'}\` tidak memiliki handler.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const wrapped = createMappedInteraction(interaction, {
        forcedSubcommand: matchedSub?.subcommand ?? subName,
        forcedAction: matchedSub?.action ?? subName,
        fixedOptions: matchedSub?.fixedOptions ?? commandConfig.fixedOptions,
      });
      return fn(wrapped, context, { commandConfig, subcommandConfig: matchedSub, groupName, subName });
    }

    const handlerKey = commandConfig.handler;
    const fn = handlerKey && Object.hasOwn(handlerRegistry, handlerKey) ? handlerRegistry[handlerKey] : null;
    if (!fn) {
      await interaction.reply({
        embeds: [buildErrorEmbed(`Handler \`${handlerKey || '(kosong)'}\` tidak ditemukan.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const wrapped = createMappedInteraction(interaction, {
      forcedSubcommand: commandConfig.subcommand,
      forcedAction: commandConfig.action,
      fixedOptions: commandConfig.fixedOptions,
    });
    return fn(wrapped, context, { commandConfig });
  };
}
