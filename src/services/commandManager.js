import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { DEFAULT_HANDLER_REGISTRY } from '../config/commandRegistry.js';

const SLASH_NAME_REGEX = /^[a-z0-9_-]{1,32}$/;
const CONTEXT_NAME_MIN = 1;
const CONTEXT_NAME_MAX = 32;
const DESCRIPTION_MAX = 100;
const MAX_OPTIONS_PER_LEVEL = 25;
const MAX_CHOICES_PER_OPTION = 25;
const MAX_CHAT_INPUT_COMMANDS = 100;
const MAX_CONTEXT_COMMANDS_PER_TYPE = 5;

const OPTION_TYPE_MAP = Object.freeze({
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
  attachment: ApplicationCommandOptionType.Attachment,
});

const CHOICE_CAPABLE_TYPES = new Set(['string', 'integer', 'number']);
const NUMERIC_OPTION_TYPES = new Set(['integer', 'number']);

/**
 * Error thrown when `commandStructure` fails validation before Discord sync.
 */
export class CommandConfigError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`Invalid command configuration (${list.length} error${list.length === 1 ? '' : 's'}):\n- ${list.join('\n- ')}`);
    this.name = 'CommandConfigError';
    this.errors = list;
  }
}

/**
 * Maps a config command `type` to Discord's `ApplicationCommandType`.
 * @param {string | number | undefined} rawType
 * @returns {number}
 */
export function resolveApplicationCommandType(rawType) {
  if (typeof rawType === 'number') {
    return rawType;
  }
  const normalized = String(rawType || 'standalone').trim().toLowerCase();
  if (normalized === 'context_message' || normalized === 'message') {
    return ApplicationCommandType.Message;
  }
  if (normalized === 'context_user' || normalized === 'user') {
    return ApplicationCommandType.User;
  }
  return ApplicationCommandType.ChatInput;
}

export function formatApplicationTypeLabel(typeCode) {
  if (typeCode === ApplicationCommandType.Message) return 'MESSAGE_CONTEXT';
  if (typeCode === ApplicationCommandType.User) return 'USER_CONTEXT';
  return 'CHAT_INPUT';
}

function validateOptionsList(options, locationLabel, errors) {
  if (!Array.isArray(options)) {
    return;
  }

  if (options.length > MAX_OPTIONS_PER_LEVEL) {
    errors.push(`${locationLabel}: exceeds maximum ${MAX_OPTIONS_PER_LEVEL} parameters (${options.length}).`);
  }

  let seenOptional = false;
  const seenNames = new Set();

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const optLabel = `${locationLabel}.options[${i}] (${opt?.name || 'unnamed'})`;

    if (!opt || typeof opt !== 'object') {
      errors.push(`${optLabel}: parameter definition must be an object.`);
      continue;
    }

    if (typeof opt.name !== 'string' || !SLASH_NAME_REGEX.test(opt.name)) {
      errors.push(`${optLabel}: invalid parameter name "${opt.name}". Must match ${SLASH_NAME_REGEX}.`);
    } else if (seenNames.has(opt.name)) {
      errors.push(`${optLabel}: duplicate parameter name "${opt.name}".`);
    } else {
      seenNames.add(opt.name);
    }

    if (typeof opt.description !== 'string' || !opt.description.trim() || opt.description.length > DESCRIPTION_MAX) {
      errors.push(`${optLabel}: parameter description must be 1–${DESCRIPTION_MAX} characters.`);
    }

    const optType = String(opt.type || '').trim().toLowerCase();
    if (!Object.hasOwn(OPTION_TYPE_MAP, optType)) {
      errors.push(
        `${optLabel}: unsupported parameter type "${opt.type}". Supported: ${Object.keys(OPTION_TYPE_MAP).join(', ')}.`,
      );
    }

    const isRequired = Boolean(opt.required);
    if (isRequired && seenOptional) {
      errors.push(`${optLabel}: required parameter "${opt.name}" cannot be placed after an optional parameter.`);
    }
    if (!isRequired) {
      seenOptional = true;
    }

    if (opt.autocomplete && Array.isArray(opt.choices) && opt.choices.length > 0) {
      errors.push(`${optLabel}: cannot enable both autocomplete and static choices.`);
    }

    if (Array.isArray(opt.choices)) {
      if (optType && !CHOICE_CAPABLE_TYPES.has(optType)) {
        errors.push(`${optLabel}: choices are only supported on string, integer, or number parameters.`);
      }
      if (opt.choices.length > MAX_CHOICES_PER_OPTION) {
        errors.push(
          `${optLabel}: choices count (${opt.choices.length}) exceeds Discord maximum ${MAX_CHOICES_PER_OPTION}.`,
        );
      }
      for (let c = 0; c < opt.choices.length; c++) {
        const choice = opt.choices[c];
        if (!choice || typeof choice.name !== 'string' || !choice.name.trim() || choice.name.length > DESCRIPTION_MAX) {
          errors.push(`${optLabel}.choices[${c}]: choice name must be 1–${DESCRIPTION_MAX} characters.`);
        }
        if (choice?.value === undefined || choice?.value === null || choice?.value === '') {
          errors.push(`${optLabel}.choices[${c}]: choice value is required.`);
        }
      }
    }

    if (opt.minValue !== undefined || opt.maxValue !== undefined) {
      if (optType && !NUMERIC_OPTION_TYPES.has(optType)) {
        errors.push(`${optLabel}: minValue/maxValue are only valid for integer or number parameters.`);
      }
      if (
        typeof opt.minValue === 'number' &&
        typeof opt.maxValue === 'number' &&
        opt.minValue > opt.maxValue
      ) {
        errors.push(`${optLabel}: minValue (${opt.minValue}) cannot exceed maxValue (${opt.maxValue}).`);
      }
    }

    if (opt.minLength !== undefined || opt.maxLength !== undefined) {
      if (optType && optType !== 'string') {
        errors.push(`${optLabel}: minLength/maxLength are only valid for string parameters.`);
      }
      if (typeof opt.minLength === 'number' && (opt.minLength < 0 || opt.minLength > 6000)) {
        errors.push(`${optLabel}: minLength must be between 0 and 6000.`);
      }
      if (typeof opt.maxLength === 'number' && (opt.maxLength < 1 || opt.maxLength > 6000)) {
        errors.push(`${optLabel}: maxLength must be between 1 and 6000.`);
      }
      if (
        typeof opt.minLength === 'number' &&
        typeof opt.maxLength === 'number' &&
        opt.minLength > opt.maxLength
      ) {
        errors.push(`${optLabel}: minLength (${opt.minLength}) cannot exceed maxLength (${opt.maxLength}).`);
      }
    }
  }
}

function validateHandlerKey(handlerKey, locationLabel, handlerRegistry, errors) {
  if (!handlerKey || typeof handlerKey !== 'string') {
    errors.push(`${locationLabel}: missing handler mapping.`);
    return;
  }
  if (!Object.hasOwn(handlerRegistry, handlerKey)) {
    errors.push(`${locationLabel}: unknown handler "${handlerKey}".`);
  }
}

/**
 * Validates the entire centralized command configuration against Discord API limits
 * and Midwave handler mappings without touching Discord REST API.
 *
 * @param {{ commands?: object[] }} structure
 * @param {{ handlerRegistry?: Record<string, Function>, validateHandlers?: boolean }} [options]
 */
export function validateCommandStructure(structure, options = {}) {
  const { handlerRegistry = DEFAULT_HANDLER_REGISTRY, validateHandlers = true } = options;
  const errors = [];
  const warnings = [];

  if (!structure || !Array.isArray(structure.commands)) {
    return {
      valid: false,
      errors: ['commandStructure.commands must be an array.'],
      warnings: [],
      topLevelCount: 0,
      chatInputCount: 0,
      userContextCount: 0,
      messageContextCount: 0,
    };
  }

  let chatInputCount = 0;
  let userContextCount = 0;
  let messageContextCount = 0;
  const enabledKeys = new Set();

  for (let i = 0; i < structure.commands.length; i++) {
    const cmd = structure.commands[i];
    const cmdLabel = `commands[${i}] (${cmd?.name || 'unnamed'})`;

    if (!cmd || typeof cmd !== 'object') {
      errors.push(`${cmdLabel}: command entry must be an object.`);
      continue;
    }

    const enabled = cmd.enabled !== false;
    const rawType = String(cmd.type || 'standalone').trim().toLowerCase();
    const appType = resolveApplicationCommandType(rawType);
    const isContext = appType === ApplicationCommandType.Message || appType === ApplicationCommandType.User;

    if (isContext) {
      if (typeof cmd.name !== 'string' || cmd.name.trim().length < CONTEXT_NAME_MIN || cmd.name.length > CONTEXT_NAME_MAX) {
        errors.push(`${cmdLabel}: context menu name must be ${CONTEXT_NAME_MIN}–${CONTEXT_NAME_MAX} characters.`);
      }
      if (cmd.description) {
        errors.push(`${cmdLabel}: context menu commands must not define a description.`);
      }
    } else {
      if (typeof cmd.name !== 'string' || !SLASH_NAME_REGEX.test(cmd.name)) {
        errors.push(`${cmdLabel}: invalid slash command name "${cmd.name}". Must match ${SLASH_NAME_REGEX}.`);
      }
      if (typeof cmd.description !== 'string' || !cmd.description.trim() || cmd.description.length > DESCRIPTION_MAX) {
        errors.push(`${cmdLabel}: slash command description must be 1–${DESCRIPTION_MAX} characters.`);
      }
    }

    const dedupeKey = `${appType}:${String(cmd.name || '').toLowerCase()}`;
    if (enabled) {
      if (enabledKeys.has(dedupeKey)) {
        errors.push(
          `${cmdLabel}: duplicate enabled command "${cmd.name}" (${formatApplicationTypeLabel(appType)}).`,
        );
      } else {
        enabledKeys.add(dedupeKey);
      }

      if (appType === ApplicationCommandType.ChatInput) chatInputCount++;
      else if (appType === ApplicationCommandType.User) userContextCount++;
      else if (appType === ApplicationCommandType.Message) messageContextCount++;
    }

    if (rawType === 'standalone' || rawType === 'choice') {
      validateOptionsList(cmd.options, cmdLabel, errors);

      if (rawType === 'choice') {
        const actionOptName = cmd.actionOptionName || 'action';
        const actionOpt = Array.isArray(cmd.options)
          ? cmd.options.find((o) => o?.name === actionOptName)
          : null;
        if (!actionOpt || !Array.isArray(actionOpt.choices) || actionOpt.choices.length === 0) {
          errors.push(`${cmdLabel}: choice command requires "${actionOptName}" option with at least 1 choice.`);
        } else if (validateHandlers) {
          for (const ch of actionOpt.choices) {
            const mapped = cmd.actionHandlers?.[ch.value] ?? cmd.handler;
            validateHandlerKey(mapped, `${cmdLabel}.choice(${ch.value})`, handlerRegistry, errors);
          }
        }
      } else if (validateHandlers) {
        validateHandlerKey(cmd.handler, cmdLabel, handlerRegistry, errors);
      }
    } else if (rawType === 'subcommand') {
      if (!Array.isArray(cmd.subcommands) || cmd.subcommands.length === 0) {
        errors.push(`${cmdLabel}: subcommand type requires at least one entry in subcommands.`);
      } else {
        if (cmd.subcommands.length > MAX_OPTIONS_PER_LEVEL) {
          errors.push(`${cmdLabel}: subcommands count (${cmd.subcommands.length}) exceeds Discord limit ${MAX_OPTIONS_PER_LEVEL}.`);
        }
        const subNames = new Set();
        for (let s = 0; s < cmd.subcommands.length; s++) {
          const sub = cmd.subcommands[s];
          const subLabel = `${cmdLabel}.subcommands[${s}] (${sub?.name || 'unnamed'})`;
          if (typeof sub?.name !== 'string' || !SLASH_NAME_REGEX.test(sub.name)) {
            errors.push(`${subLabel}: invalid subcommand name "${sub?.name}".`);
          } else if (subNames.has(sub.name)) {
            errors.push(`${subLabel}: duplicate subcommand name "${sub.name}".`);
          } else {
            subNames.add(sub.name);
          }
          if (typeof sub?.description !== 'string' || !sub.description.trim() || sub.description.length > DESCRIPTION_MAX) {
            errors.push(`${subLabel}: subcommand description must be 1–${DESCRIPTION_MAX} characters.`);
          }
          validateOptionsList(sub?.options, subLabel, errors);
          if (validateHandlers) {
            validateHandlerKey(sub?.handler ?? cmd.handler, subLabel, handlerRegistry, errors);
          }
        }
      }
    } else if (rawType === 'grouped') {
      const groups = Array.isArray(cmd.groups) ? cmd.groups : [];
      const topSubs = Array.isArray(cmd.subcommands) ? cmd.subcommands : [];
      if (groups.length === 0) {
        errors.push(`${cmdLabel}: grouped type requires at least one entry in groups.`);
      }
      if (groups.length + topSubs.length > MAX_OPTIONS_PER_LEVEL) {
        errors.push(`${cmdLabel}: total groups + subcommands exceeds Discord limit ${MAX_OPTIONS_PER_LEVEL}.`);
      }

      const topNames = new Set();
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const grpLabel = `${cmdLabel}.groups[${g}] (${grp?.name || 'unnamed'})`;
        if (typeof grp?.name !== 'string' || !SLASH_NAME_REGEX.test(grp.name)) {
          errors.push(`${grpLabel}: invalid group name "${grp?.name}".`);
        } else if (topNames.has(grp.name)) {
          errors.push(`${grpLabel}: duplicate group/subcommand name "${grp.name}".`);
        } else {
          topNames.add(grp.name);
        }
        if (typeof grp?.description !== 'string' || !grp.description.trim() || grp.description.length > DESCRIPTION_MAX) {
          errors.push(`${grpLabel}: group description must be 1–${DESCRIPTION_MAX} characters.`);
        }
        if (!Array.isArray(grp?.subcommands) || grp.subcommands.length === 0) {
          errors.push(`${grpLabel}: group must contain at least one subcommand.`);
        } else {
          if (grp.subcommands.length > MAX_OPTIONS_PER_LEVEL) {
            errors.push(`${grpLabel}: group subcommands exceed Discord limit ${MAX_OPTIONS_PER_LEVEL}.`);
          }
          const subNames = new Set();
          for (let s = 0; s < grp.subcommands.length; s++) {
            const sub = grp.subcommands[s];
            const subLabel = `${grpLabel}.subcommands[${s}] (${sub?.name || 'unnamed'})`;
            if (typeof sub?.name !== 'string' || !SLASH_NAME_REGEX.test(sub.name)) {
              errors.push(`${subLabel}: invalid subcommand name "${sub?.name}".`);
            } else if (subNames.has(sub.name)) {
              errors.push(`${subLabel}: duplicate subcommand name "${sub.name}" in group.`);
            } else {
              subNames.add(sub.name);
            }
            if (typeof sub?.description !== 'string' || !sub.description.trim() || sub.description.length > DESCRIPTION_MAX) {
              errors.push(`${subLabel}: subcommand description must be 1–${DESCRIPTION_MAX} characters.`);
            }
            validateOptionsList(sub?.options, subLabel, errors);
            if (validateHandlers) {
              validateHandlerKey(sub?.handler ?? grp?.handler ?? cmd.handler, subLabel, handlerRegistry, errors);
            }
          }
        }
      }

      for (let s = 0; s < topSubs.length; s++) {
        const sub = topSubs[s];
        const subLabel = `${cmdLabel}.subcommands[${s}] (${sub?.name || 'unnamed'})`;
        if (typeof sub?.name !== 'string' || !SLASH_NAME_REGEX.test(sub.name)) {
          errors.push(`${subLabel}: invalid subcommand name "${sub?.name}".`);
        } else if (topNames.has(sub.name)) {
          errors.push(`${subLabel}: duplicate group/subcommand name "${sub.name}".`);
        } else {
          topNames.add(sub.name);
        }
        if (typeof sub?.description !== 'string' || !sub.description.trim() || sub.description.length > DESCRIPTION_MAX) {
          errors.push(`${subLabel}: subcommand description must be 1–${DESCRIPTION_MAX} characters.`);
        }
        validateOptionsList(sub?.options, subLabel, errors);
        if (validateHandlers) {
          validateHandlerKey(sub?.handler ?? cmd.handler, subLabel, handlerRegistry, errors);
        }
      }
    } else if (isContext) {
      if (validateHandlers) {
        validateHandlerKey(cmd.handler, cmdLabel, handlerRegistry, errors);
      }
    } else {
      errors.push(
        `${cmdLabel}: unsupported command type "${cmd.type}". Use standalone, choice, subcommand, grouped, context_message, or context_user.`,
      );
    }

    if (!enabled) {
      warnings.push(`Command "${cmd.name}" (${rawType}) is disabled and will not be registered.`);
    }
  }

  if (chatInputCount > MAX_CHAT_INPUT_COMMANDS) {
    errors.push(`Enabled slash commands (${chatInputCount}) exceed Discord maximum ${MAX_CHAT_INPUT_COMMANDS}.`);
  }
  if (userContextCount > MAX_CONTEXT_COMMANDS_PER_TYPE) {
    errors.push(`Enabled user context menus (${userContextCount}) exceed Discord maximum ${MAX_CONTEXT_COMMANDS_PER_TYPE}.`);
  }
  if (messageContextCount > MAX_CONTEXT_COMMANDS_PER_TYPE) {
    errors.push(`Enabled message context menus (${messageContextCount}) exceed Discord maximum ${MAX_CONTEXT_COMMANDS_PER_TYPE}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    topLevelCount: chatInputCount + userContextCount + messageContextCount,
    chatInputCount,
    userContextCount,
    messageContextCount,
  };
}

/**
 * Validates `commandStructure` and throws `CommandConfigError` on any violation.
 * @param {object} structure
 * @param {object} [options]
 */
export function assertValidCommandStructure(structure, options = {}) {
  const report = validateCommandStructure(structure, options);
  if (!report.valid) {
    throw new CommandConfigError(report.errors);
  }
  return report;
}

function applyOptionToBuilder(targetBuilder, opt) {
  const type = String(opt.type || 'string').trim().toLowerCase();

  const configureCommon = (o) => {
    o.setName(opt.name).setDescription(opt.description).setRequired(Boolean(opt.required));
    return o;
  };

  if (type === 'string') {
    targetBuilder.addStringOption((o) => {
      configureCommon(o);
      if (Array.isArray(opt.choices) && opt.choices.length > 0) o.addChoices(...opt.choices);
      if (opt.autocomplete) o.setAutocomplete(true);
      if (typeof opt.minLength === 'number') o.setMinLength(opt.minLength);
      if (typeof opt.maxLength === 'number') o.setMaxLength(opt.maxLength);
      return o;
    });
  } else if (type === 'integer') {
    targetBuilder.addIntegerOption((o) => {
      configureCommon(o);
      if (Array.isArray(opt.choices) && opt.choices.length > 0) o.addChoices(...opt.choices);
      if (opt.autocomplete) o.setAutocomplete(true);
      if (typeof opt.minValue === 'number') o.setMinValue(opt.minValue);
      if (typeof opt.maxValue === 'number') o.setMaxValue(opt.maxValue);
      return o;
    });
  } else if (type === 'number') {
    targetBuilder.addNumberOption((o) => {
      configureCommon(o);
      if (Array.isArray(opt.choices) && opt.choices.length > 0) o.addChoices(...opt.choices);
      if (opt.autocomplete) o.setAutocomplete(true);
      if (typeof opt.minValue === 'number') o.setMinValue(opt.minValue);
      if (typeof opt.maxValue === 'number') o.setMaxValue(opt.maxValue);
      return o;
    });
  } else if (type === 'boolean') {
    targetBuilder.addBooleanOption((o) => configureCommon(o));
  } else if (type === 'user') {
    targetBuilder.addUserOption((o) => configureCommon(o));
  } else if (type === 'channel') {
    targetBuilder.addChannelOption((o) => {
      configureCommon(o);
      if (Array.isArray(opt.channelTypes) && opt.channelTypes.length > 0) {
        o.addChannelTypes(...opt.channelTypes);
      }
      return o;
    });
  } else if (type === 'role') {
    targetBuilder.addRoleOption((o) => configureCommon(o));
  } else if (type === 'attachment') {
    targetBuilder.addAttachmentOption((o) => configureCommon(o));
  }
}

/**
 * Compiles a single validated config command into a Discord.js builder instance.
 * @param {object} cmd
 * @returns {SlashCommandBuilder | ContextMenuCommandBuilder}
 */
export function buildCommandBuilder(cmd) {
  const appType = resolveApplicationCommandType(cmd.type);

  if (appType === ApplicationCommandType.Message || appType === ApplicationCommandType.User) {
    const ctxBuilder = new ContextMenuCommandBuilder().setName(cmd.name).setType(appType);
    if (cmd.defaultMemberPermissions !== undefined && cmd.defaultMemberPermissions !== null) {
      ctxBuilder.setDefaultMemberPermissions(cmd.defaultMemberPermissions);
    }
    if (Array.isArray(cmd.contexts) && cmd.contexts.length > 0) {
      ctxBuilder.setContexts(cmd.contexts);
    }
    if (Array.isArray(cmd.integrationTypes) && cmd.integrationTypes.length > 0) {
      ctxBuilder.setIntegrationTypes(cmd.integrationTypes);
    }
    return ctxBuilder;
  }

  const builder = new SlashCommandBuilder().setName(cmd.name).setDescription(cmd.description);

  if (cmd.defaultMemberPermissions !== undefined && cmd.defaultMemberPermissions !== null) {
    builder.setDefaultMemberPermissions(cmd.defaultMemberPermissions);
  }
  if (Array.isArray(cmd.contexts) && cmd.contexts.length > 0) {
    builder.setContexts(cmd.contexts);
  }
  if (Array.isArray(cmd.integrationTypes) && cmd.integrationTypes.length > 0) {
    builder.setIntegrationTypes(cmd.integrationTypes);
  }

  const rawType = String(cmd.type || 'standalone').trim().toLowerCase();

  if (rawType === 'standalone' || rawType === 'choice') {
    for (const opt of cmd.options ?? []) {
      applyOptionToBuilder(builder, opt);
    }
  } else if (rawType === 'subcommand') {
    for (const sub of cmd.subcommands ?? []) {
      builder.addSubcommand((subBuilder) => {
        subBuilder.setName(sub.name).setDescription(sub.description);
        for (const opt of sub.options ?? []) {
          applyOptionToBuilder(subBuilder, opt);
        }
        return subBuilder;
      });
    }
  } else if (rawType === 'grouped') {
    for (const grp of cmd.groups ?? []) {
      builder.addSubcommandGroup((groupBuilder) => {
        groupBuilder.setName(grp.name).setDescription(grp.description);
        for (const sub of grp.subcommands ?? []) {
          groupBuilder.addSubcommand((subBuilder) => {
            subBuilder.setName(sub.name).setDescription(sub.description);
            for (const opt of sub.options ?? []) {
              applyOptionToBuilder(subBuilder, opt);
            }
            return subBuilder;
          });
        }
        return groupBuilder;
      });
    }
    for (const sub of cmd.subcommands ?? []) {
      builder.addSubcommand((subBuilder) => {
        subBuilder.setName(sub.name).setDescription(sub.description);
        for (const opt of sub.options ?? []) {
          applyOptionToBuilder(subBuilder, opt);
        }
        return subBuilder;
      });
    }
  }

  return builder;
}

/**
 * Compiles all enabled commands from `commandStructure` into Discord REST JSON payloads.
 * @param {object} structure
 * @param {object} [options]
 * @returns {object[]}
 */
export function buildCommandPayloads(structure, options = {}) {
  assertValidCommandStructure(structure, options);
  return structure.commands
    .filter((cmd) => cmd.enabled !== false)
    .map((cmd) => buildCommandBuilder(cmd).toJSON());
}

/**
 * Detects duplicate commands across configuration, single-scope Discord lists,
 * and cross-scope (global + guild) registrations.
 *
 * @param {{
 *   configCommands?: object[],
 *   globalCommands?: object[],
 *   guildCommands?: object[],
 *   guildId?: string,
 * }} [params]
 */
export function detectDuplicateCommands({
  configCommands = [],
  globalCommands = [],
  guildCommands = [],
  guildId = '',
} = {}) {
  const duplicates = [];

  const checkWithinList = (list, scopeLabel, sourceLabel) => {
    const seen = new Map();
    for (const cmd of list) {
      const type = resolveApplicationCommandType(cmd.type);
      const key = `${type}:${String(cmd.name || '').toLowerCase()}`;
      if (seen.has(key)) {
        duplicates.push({
          name: cmd.name,
          type: formatApplicationTypeLabel(type),
          scopes: [scopeLabel],
          sources: [sourceLabel],
          cause: `Duplicate (${cmd.name}, ${formatApplicationTypeLabel(type)}) inside ${sourceLabel}.`,
        });
      } else {
        seen.set(key, cmd);
      }
    }
    return seen;
  };

  checkWithinList(
    configCommands.filter((c) => c?.enabled !== false),
    'config',
    'src/config/commandStructure.js',
  );
  const globalMap = checkWithinList(globalCommands, 'global', 'Discord Global Application Commands');
  const guildMap = checkWithinList(
    guildCommands,
    guildId ? `guild:${guildId}` : 'guild',
    'Discord Guild Application Commands',
  );

  for (const [key, gCmd] of globalMap.entries()) {
    if (guildMap.has(key)) {
      const guildScope = guildId ? `guild:${guildId}` : 'guild';
      const typeLabel = formatApplicationTypeLabel(resolveApplicationCommandType(gCmd.type));
      duplicates.push({
        name: gCmd.name,
        type: typeLabel,
        scopes: ['global', guildScope],
        sources: ['Discord Global Application Commands', 'Discord Guild Application Commands'],
        cause: `Command "${gCmd.name}" (${typeLabel}) is registered in BOTH global and ${guildScope} scopes simultaneously, causing duplicate entries in Discord's command picker.`,
      });
    }
  }

  return {
    hasDuplicates: duplicates.length > 0,
    duplicates,
  };
}

function summarizeOption(opt) {
  return {
    name: opt.name,
    type: String(opt.type || 'string').toLowerCase(),
    required: Boolean(opt.required),
    choices: Array.isArray(opt.choices) ? opt.choices.map((c) => c.value) : [],
  };
}

function summarizeCommandConfig(cmd) {
  const rawType = String(cmd.type || 'standalone').toLowerCase();
  const appType = resolveApplicationCommandType(rawType);
  return {
    name: cmd.name,
    type: rawType,
    applicationType: formatApplicationTypeLabel(appType),
    enabled: cmd.enabled !== false,
    options: (cmd.options ?? []).map(summarizeOption),
    subcommands: (cmd.subcommands ?? []).map((s) => ({
      name: s.name,
      options: (s.options ?? []).map(summarizeOption),
    })),
    groups: (cmd.groups ?? []).map((g) => ({
      name: g.name,
      subcommands: (g.subcommands ?? []).map((s) => ({
        name: s.name,
        options: (s.options ?? []).map(summarizeOption),
      })),
    })),
  };
}

function buildPayloadKey(cmd) {
  const type = resolveApplicationCommandType(cmd.type);
  return `${type}:${String(cmd.name || '').toLowerCase()}`;
}

/**
 * Generates a full validation + structure preview + remote diff before sync.
 *
 * @param {{
 *   structure: object,
 *   handlerRegistry?: Record<string, Function>,
 *   restClient?: { get?: Function },
 *   clientId?: string,
 *   guildId?: string,
 *   scope?: 'guild' | 'global',
 *   checkCrossScopeDuplicates?: boolean,
 * }} options
 */
export async function previewCommandSync(options) {
  const {
    structure,
    handlerRegistry = DEFAULT_HANDLER_REGISTRY,
    restClient = null,
    clientId = '',
    guildId = '',
    scope = 'guild',
    checkCrossScopeDuplicates = true,
  } = options;

  const validation = assertValidCommandStructure(structure, { handlerRegistry });
  const payloads = buildCommandPayloads(structure, { handlerRegistry });

  const enabledConfigs = structure.commands.filter((c) => c.enabled !== false);
  const disabledConfigs = structure.commands.filter((c) => c.enabled === false);

  let currentRemote = null;
  let globalCommands = [];
  let guildCommands = [];

  if (restClient && typeof restClient.get === 'function' && clientId) {
    if (scope === 'global') {
      globalCommands = (await restClient.get(Routes.applicationCommands(clientId))) ?? [];
      currentRemote = globalCommands;
      if (checkCrossScopeDuplicates && guildId) {
        guildCommands = (await restClient.get(Routes.applicationGuildCommands(clientId, guildId))) ?? [];
      }
    } else if (guildId) {
      guildCommands = (await restClient.get(Routes.applicationGuildCommands(clientId, guildId))) ?? [];
      currentRemote = guildCommands;
      if (checkCrossScopeDuplicates) {
        globalCommands = (await restClient.get(Routes.applicationCommands(clientId))) ?? [];
      }
    }
  }

  const targetKeys = new Map(payloads.map((p) => [buildPayloadKey(p), p]));
  const toCreate = [];
  const toUpdate = [];
  const toDelete = [];

  if (Array.isArray(currentRemote)) {
    const remoteKeys = new Map(currentRemote.map((r) => [buildPayloadKey(r), r]));
    for (const [key, payload] of targetKeys.entries()) {
      if (remoteKeys.has(key)) {
        toUpdate.push(payload.name);
      } else {
        toCreate.push(payload.name);
      }
    }
    for (const [key, remoteCmd] of remoteKeys.entries()) {
      if (!targetKeys.has(key)) {
        toDelete.push(remoteCmd.name);
      }
    }
  } else {
    for (const payload of payloads) {
      toCreate.push(payload.name);
    }
  }

  const duplicateReport = detectDuplicateCommands({
    configCommands: structure.commands,
    globalCommands,
    guildCommands,
    guildId,
  });

  return {
    scope,
    validation,
    topLevelCount: validation.topLevelCount,
    payloads,
    enabledCommands: enabledConfigs.map(summarizeCommandConfig),
    disabledCommands: disabledConfigs.map((c) => ({ name: c.name, type: c.type || 'standalone' })),
    diff: {
      remoteChecked: Array.isArray(currentRemote),
      toCreate,
      toUpdate,
      toDelete,
    },
    duplicates: duplicateReport,
  };
}

/**
 * Formats a human-readable CLI preview summary for safe review before sync.
 * @param {Awaited<ReturnType<typeof previewCommandSync>>} preview
 * @returns {string}
 */
export function formatSyncPreview(preview) {
  const lines = [
    `[CommandPreview] Scope: ${preview.scope} | Top-level commands: ${preview.topLevelCount}`,
    `  Enabled (${preview.enabledCommands.length}): ${preview.enabledCommands.map((c) => `${c.name} [${c.type}]`).join(', ') || '(none)'}`,
  ];

  if (preview.disabledCommands.length > 0) {
    lines.push(
      `  Disabled (${preview.disabledCommands.length}): ${preview.disabledCommands.map((c) => c.name).join(', ')}`,
    );
  }

  for (const cmd of preview.enabledCommands) {
    if (cmd.options.length > 0) {
      const optSummary = cmd.options
        .map((o) => `${o.name}:${o.type}${o.required ? '*' : '?'}${o.choices.length ? `[${o.choices.length}]` : ''}`)
        .join(', ');
      lines.push(`    - /${cmd.name} (${optSummary})`);
    }
    for (const grp of cmd.groups) {
      lines.push(`    - /${cmd.name} group:${grp.name} -> ${grp.subcommands.map((s) => s.name).join(', ')}`);
    }
    if (cmd.subcommands.length > 0) {
      lines.push(`    - /${cmd.name} subcommands: ${cmd.subcommands.map((s) => s.name).join(', ')}`);
    }
  }

  if (preview.diff.remoteChecked) {
    lines.push(
      `  Sync Diff -> Create: [${preview.diff.toCreate.join(', ')}] | Update: [${preview.diff.toUpdate.join(', ')}] | Remove: [${preview.diff.toDelete.join(', ')}]`,
    );
  }

  if (preview.duplicates.hasDuplicates) {
    for (const dup of preview.duplicates.duplicates) {
      lines.push(`  [DUPLICATE WARNING] ${dup.cause}`);
    }
  }

  return lines.join('\n');
}

/**
 * Safely validates, previews, syncs, and verifies Midwave application commands with Discord REST API.
 * Never touches Discord commands if configuration validation fails.
 *
 * @param {{
 *   structure: object,
 *   handlerRegistry?: Record<string, Function>,
 *   global?: boolean,
 *   dryRun?: boolean,
 *   restClient?: { get?: Function, put: Function },
 *   token?: string,
 *   clientId?: string,
 *   guildId?: string,
 *   logger?: Console,
 * }} options
 */
export async function syncCommands(options) {
  const {
    structure,
    handlerRegistry = DEFAULT_HANDLER_REGISTRY,
    global: isGlobal = false,
    dryRun = false,
    restClient = null,
    token = '',
    clientId = '',
    guildId = '',
    logger = console,
  } = options;

  const scope = isGlobal ? 'global' : 'guild';
  if (!clientId) {
    throw new Error('Missing CLIENT_ID environment variable.');
  }
  if (!isGlobal && !guildId) {
    throw new Error('Missing GUILD_ID environment variable (required for guild deployment, or pass --global).');
  }
  if (!restClient && !token && !dryRun) {
    throw new Error('Missing DISCORD_TOKEN environment variable.');
  }

  const rest = restClient ?? (token ? new REST({ version: '10' }).setToken(token) : null);

  // Step 1–5: Validate config, compile payloads, preview, and inspect remote state + duplicates
  const preview = await previewCommandSync({
    structure,
    handlerRegistry,
    restClient: rest,
    clientId,
    guildId,
    scope,
  });

  if (preview.payloads.length === 0) {
    throw new Error('No enabled commands in commandStructure to register.');
  }

  logger.log?.(formatSyncPreview(preview));

  if (dryRun) {
    return {
      synced: false,
      dryRun: true,
      preview,
      result: [],
    };
  }

  // Step 6: Execute scoped registration (replaces legacy/disabled commands in managed scope only)
  const route = isGlobal
    ? Routes.applicationCommands(clientId)
    : Routes.applicationGuildCommands(clientId, guildId);
  const scopeLabel = isGlobal ? 'global' : `guild (${guildId})`;
  logger.log?.(`[Deploy] Registering ${preview.payloads.length} commands to ${scopeLabel}...`);

  const result = await rest.put(route, { body: preview.payloads });

  // Step 7: Verify registered commands from API response
  const returnedKeys = Array.isArray(result)
    ? new Set(result.map((cmd) => buildPayloadKey(cmd)))
    : new Set(preview.payloads.map((cmd) => buildPayloadKey(cmd)));

  const missingNames = preview.payloads
    .filter((cmd) => !returnedKeys.has(buildPayloadKey(cmd)))
    .map((cmd) => cmd.name);

  if (missingNames.length > 0) {
    throw new Error(`Discord API response missing expected commands: ${missingNames.join(', ')}`);
  }

  const registeredNames = Array.isArray(result)
    ? result.map((c) => c.name).sort()
    : preview.payloads.map((c) => c.name).sort();
  logger.log?.(
    `[Deploy] Successfully registered ${registeredNames.length} commands: ${registeredNames.join(', ')}`,
  );

  return {
    synced: true,
    dryRun: false,
    preview,
    result,
  };
}
