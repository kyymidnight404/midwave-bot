import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { COLORS } from '../config/colors.js';
import defaultCommandStructure from '../config/commandStructure.js';
import { SOCIAL_INTERACTIONS } from './otakuGifsService.js';
import {
  LOGO_ATTACHMENT_URL,
  LOGO_PATH,
} from '../utils/constants.js';

const MENU_ICON_PATH = path.resolve(process.cwd(), 'assets/icon/menu.png');
const MENU_ICON_ATTACHMENT_URL = 'attachment://menu.png';

export const HELP_SELECT_CUSTOM_ID = 'midwave:help:category';

export const PREFIX_ONLY_METADATA = Object.freeze({
  igf: Object.freeze({
    name: 'igf',
    category: 'media_utilities',
    usage: 'igf <username>',
    description: 'Ambil profil & postingan Instagram',
    visibility: 'public',
  }),
  say: Object.freeze({
    name: 'say',
    category: 'media_utilities',
    usage: 'say <teks>',
    description: 'Kirim ulang pesan teks melalui bot',
    visibility: 'public',
  }),
  feedback: Object.freeze({
    name: 'feedback',
    category: 'general',
    usage: 'feedback',
    description: 'Kirim bug report, saran fitur, atau masukan ke tim staff',
    visibility: 'public',
  }),
  coinflip: Object.freeze({
    name: 'coinflip',
    category: 'mini_games',
    usage: 'coinflip [heads|tails | @user]',
    description: 'Main Coin Flip solo atau tantang pemain dengan tombol interaktif',
    visibility: 'public',
  }),
  rps: Object.freeze({
    name: 'rps',
    category: 'mini_games',
    usage: 'rps <rock|paper|scissors> | rps @user',
    description: 'Main Rock Paper Scissors solo atau Best of 3 vs pemain lain',
    visibility: 'public',
  }),
  tictactoe: Object.freeze({
    name: 'tictactoe',
    category: 'mini_games',
    usage: 'tictactoe @user',
    description: 'Main Tic Tac Toe bersama teman',
    visibility: 'public',
  }),
  quiz: Object.freeze({
    name: 'quiz',
    category: 'mini_games',
    usage: 'quiz [kategori] [kesulitan]',
    description: 'Mulai Quiz langsung & jawab a/b/c/d di chat',
    visibility: 'public',
  }),
  knowledge: Object.freeze({
    name: 'knowledge',
    category: 'ai_knowledge',
    usage: 'knowledge <categories|search|add|update|list|remove|reload>',
    description: 'Kelola Global Bot Knowledge Midwave (Admin)',
    visibility: 'admin',
  }),
  servers: Object.freeze({
    name: 'servers',
    category: null,
    usage: 'servers',
    description: 'Daftar server yang diikuti bot (Bot Owner Only)',
    visibility: 'internal',
  }),
});

const registeredPrefixCommandNames = new Set();
let defaultHandlerRegistry = null;

/**
 * Registers active prefix command names from PrefixCommandHandler without creating a circular import.
 * @param {Iterable<string>} names
 */
export function registerPrefixCommandNames(names) {
  registeredPrefixCommandNames.clear();
  for (const name of names || []) {
    registeredPrefixCommandNames.add(name);
  }
}

/**
 * Registers the default handler registry from commandRegistry without creating a circular import.
 * @param {Record<string, Function>} registry
 */
export function registerDefaultHandlerRegistry(registry) {
  defaultHandlerRegistry = registry || null;
}

export const HELP_CATEGORIES = Object.freeze([
  {
    key: 'ai_knowledge',
    label: 'AI & Knowledge',
    emoji: '<:bot:1571472389592584344>',
    description: 'Asisten AI & manajemen pengetahuan',
  },
  {
    key: 'mini_games',
    label: 'Mini Games',
    emoji: '<:game:1571472414875844618>',
    description: 'Permainan solo & multiplayer',
  },
  {
    key: 'social',
    label: 'Social Interactions',
    emoji: '<:star:1571472439962107985>',
    description: 'Interaksi sosial & ekspresi GIF anime',
  },
  {
    key: 'media_utilities',
    label: 'Media & Utilities',
    emoji: '<:tools:1571472462787641414>',
    description: 'Pembuat gambar, lirik, downloader & utilitas',
  },
  {
    key: 'general',
    label: 'General',
    emoji: '<:pin:1571472304645345300>',
    description: 'Informasi & panduan command Midwave',
  },
]);

const CATEGORY_KEY_SET = new Set(HELP_CATEGORIES.map((cat) => cat.key));
const MAX_FIELD_LENGTH = 1024;
const MAX_EMBED_TOTAL_LENGTH = 5800;

/**
 * Checks whether a member permissions object satisfies the required permission bits.
 * @param {import('discord.js').PermissionsBitField|bigint|number|null|undefined} memberPermissions
 * @param {bigint|number|string|null|undefined} requiredPermissions
 * @returns {boolean}
 */
export function hasRequiredHelpPermissions(memberPermissions, requiredPermissions) {
  if (requiredPermissions == null) {
    return true;
  }
  if (!memberPermissions) {
    return false;
  }

  try {
    if (typeof memberPermissions.has === 'function') {
      return Boolean(memberPermissions.has(requiredPermissions));
    }
    const memberBits = BigInt(memberPermissions);
    const requiredBits = BigInt(requiredPermissions);
    return (memberBits & requiredBits) === requiredBits;
  } catch {
    return false;
  }
}

function isCommandVisibleToUser(cmd, memberPermissions) {
  const visibility = cmd.help?.visibility || (cmd.defaultMemberPermissions ? 'admin' : 'public');
  if (visibility === 'internal') {
    return false;
  }

  const requiredPerms =
    cmd.help?.requiredPermissions ??
    cmd.defaultMemberPermissions ??
    (visibility === 'admin' ? PermissionFlagsBits.Administrator : null);

  return hasRequiredHelpPermissions(memberPermissions, requiredPerms);
}

function isHandlerAvailable(cmd, commandHandler, handlerRegistry) {
  if (cmd.enabled === false) {
    return false;
  }

  if (commandHandler?.commands instanceof Map && !commandHandler.commands.has(cmd.name)) {
    return false;
  }

  if (!handlerRegistry) {
    return true;
  }

  const handlerKey = cmd.handler || cmd.name;
  if (typeof handlerRegistry[handlerKey] === 'function') {
    return true;
  }

  if (cmd.actionHandlers) {
    return Object.values(cmd.actionHandlers).some(
      (actionHandlerKey) => typeof handlerRegistry[actionHandlerKey] === 'function'
    );
  }

  if (Array.isArray(cmd.subcommands)) {
    return cmd.subcommands.some((sub) => typeof handlerRegistry[sub?.handler] === 'function');
  }

  return false;
}

function normalizeCategoryKey(categoryKey) {
  return CATEGORY_KEY_SET.has(categoryKey) ? categoryKey : 'general';
}

function buildGenericCommandLine(cmd, { prefix, registeredPrefixCommands }) {
  const description = cmd.help?.description || cmd.description || 'Perintah Midwave';

  if (cmd.type === 'context_message' || cmd.type === 'context_user') {
    const usage = cmd.help?.usage || `Apps → ${cmd.name}`;
    return `• \`${usage}\` *(Context Menu)* — ${description}`;
  }

  const slashUsage = cmd.help?.usage || cmd.name;
  const prefixName = cmd.help?.prefixName || cmd.name;
  const hasPrefix = registeredPrefixCommands.has(prefixName);

  if (hasPrefix) {
    const rawPrefixUsage = cmd.help?.prefixUsage || `{prefix}${prefixName}`;
    const prefixUsage = rawPrefixUsage.replace(/\{prefix\}/g, prefix);
    return `• \`${prefixUsage}\` | \`/${slashUsage}\` — ${description}`;
  }

  return `• \`/${slashUsage}\` *(Slash)* — ${description}`;
}

function buildMediaEntries(cmd, { prefix, handlerRegistry, registeredPrefixCommands }) {
  const actionHelp = cmd.help?.actionHelp || {};
  const isSubcommand = cmd.type === 'subcommand' || Array.isArray(cmd.subcommands);
  const actionOption = cmd.options?.find((opt) => opt.name === 'action');
  const actionKeys = isSubcommand
    ? (cmd.subcommands || []).map((s) => s.name)
    : actionOption?.choices?.map((c) => c.value) || Object.keys(actionHelp);
  const category = normalizeCategoryKey(cmd.help?.category || 'media_utilities');
  const entries = [];

  for (const actionKey of actionKeys) {
    const matchedSub = isSubcommand ? cmd.subcommands?.find((s) => s.name === actionKey) : null;
    const actionHandlerKey = matchedSub?.handler ?? cmd.actionHandlers?.[actionKey];
    if (handlerRegistry && actionHandlerKey && typeof handlerRegistry[actionHandlerKey] !== 'function') {
      continue;
    }

    const meta = actionHelp[actionKey] || {};
    const description = meta.description || matchedSub?.description || `Fitur ${actionKey}`;
    const slashUsage = meta.usage || (isSubcommand ? `${cmd.name} ${actionKey}` : `${cmd.name} action:${actionKey}`);
    const hasPrefix = registeredPrefixCommands.has(actionKey) && Boolean(meta.prefixUsage);

    const line = hasPrefix
      ? `• \`${meta.prefixUsage.replace(/\{prefix\}/g, prefix)}\` | \`/${slashUsage}\` — ${description}`
      : `• \`/${slashUsage}\` *(Slash)* — ${description}`;

    entries.push({
      id: `media:${actionKey}`,
      category,
      items: [actionKey],
      line,
      source: hasPrefix ? 'both' : 'slash',
    });
  }

  return entries;
}

function buildSocialEntries(cmd, { prefix, registeredPrefixCommands }) {
  const category = normalizeCategoryKey(cmd.help?.category || 'social');
  const interactions = Object.values(SOCIAL_INTERACTIONS);
  const targeted = interactions.filter((item) => item.requiresTarget).map((item) => item.command);
  const solo = interactions.filter((item) => !item.requiresTarget).map((item) => item.command);
  const hasPrefix = interactions.some((item) => registeredPrefixCommands.has(item.command));

  const primaryLine = hasPrefix
    ? `• \`${prefix}<aksi> [@user]\` | \`/social <action> [@user]\` — Interaksi sosial & GIF anime`
    : `• \`/social <action> [@user]\` *(Slash)* — Interaksi sosial & GIF anime`;

  const lines = [primaryLine];
  if (targeted.length > 0) {
    lines.push(`  ◦ **Target (@user):** ${targeted.map((a) => `\`${a}\``).join(', ')}`);
  }
  if (solo.length > 0) {
    lines.push(`  ◦ **Solo:** ${solo.map((a) => `\`${a}\``).join(', ')}`);
  }

  return [
    {
      id: 'command:social',
      category,
      items: interactions.map((item) => item.command),
      line: lines.join('\n'),
      source: hasPrefix ? 'both' : 'slash',
    },
  ];
}

/**
 * Dynamically discovers visible, enabled, and valid Midwave commands for the help guide.
 * @param {object} [options]
 * @returns {Array<{ id: string, category: string, line: string, source: 'prefix'|'slash'|'both' }>}
 */
export function discoverHelpEntries({
  commandStructure = defaultCommandStructure,
  commandHandler = null,
  handlerRegistry = defaultHandlerRegistry,
  registeredPrefixCommands = registeredPrefixCommandNames,
  prefixOnlyMetadata = PREFIX_ONLY_METADATA,
  memberPermissions = null,
  prefix = '!',
} = {}) {
  const entries = [];
  const seenIds = new Set();
  const coveredPrefixNames = new Set();

  const addEntry = (entry) => {
    if (!entry || seenIds.has(entry.id)) {
      return;
    }
    seenIds.add(entry.id);
    entries.push(entry);
  };

  for (const cmd of commandStructure?.commands || []) {
    if (!isCommandVisibleToUser(cmd, memberPermissions)) {
      continue;
    }
    if (!isHandlerAvailable(cmd, commandHandler, handlerRegistry)) {
      continue;
    }

    coveredPrefixNames.add(cmd.name);

    if (cmd.name === 'media' && cmd.help?.actionHelp) {
      for (const mediaEntry of buildMediaEntries(cmd, {
        prefix,
        handlerRegistry,
        registeredPrefixCommands,
      })) {
        coveredPrefixNames.add(mediaEntry.id.replace('media:', ''));
        addEntry(mediaEntry);
      }
      continue;
    }

    if (cmd.name === 'social') {
      for (const socialEntry of buildSocialEntries(cmd, { prefix, registeredPrefixCommands })) {
        addEntry(socialEntry);
      }
      Object.keys(SOCIAL_INTERACTIONS).forEach((s) => coveredPrefixNames.add(s));
      continue;
    }

    const category = normalizeCategoryKey(cmd.help?.category || 'general');
    const prefixName = cmd.help?.prefixName || cmd.name;
    if (cmd.help?.prefixName) {
      coveredPrefixNames.add(cmd.help.prefixName);
    }
    const hasPrefix = registeredPrefixCommands.has(prefixName);
    addEntry({
      id: `command:${cmd.name}`,
      category,
      items: [prefixName],
      line: buildGenericCommandLine(cmd, { prefix, registeredPrefixCommands }),
      source: hasPrefix ? 'both' : 'slash',
    });
  }

  for (const prefixName of registeredPrefixCommands) {
    if (coveredPrefixNames.has(prefixName)) {
      continue;
    }
    const meta = prefixOnlyMetadata?.[prefixName];
    if (!meta) {
      continue;
    }
    if (meta.visibility === 'internal') {
      continue;
    }
    if (meta.visibility === 'admin' || meta.requiredPermissions) {
      const req = meta.requiredPermissions ?? PermissionFlagsBits.Administrator;
      if (!hasRequiredHelpPermissions(memberPermissions, req)) {
        continue;
      }
    }

    const category = normalizeCategoryKey(meta.category || 'general');
    addEntry({
      id: `prefix:${prefixName}`,
      category,
      items: [prefixName],
      line: `• \`${prefix}${meta.usage || prefixName}\` *(Prefix)* — ${meta.description}`,
      source: 'prefix',
    });
  }

  return entries;
}

function truncateFieldValue(text, maxLength = MAX_FIELD_LENGTH) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 4)}\n...`;
}

/**
 * Builds the Midnight Ocean Help Embed from discovered command entries.
 * @param {object} [options]
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildDynamicHelpEmbed({
  entries = null,
  categoryKey = 'all',
  prefix = '!',
} = {}) {
  const resolvedEntries = entries ?? discoverHelpEntries({ prefix });
  const selectedCategory = HELP_CATEGORIES.find((cat) => cat.key === categoryKey);

  const description = selectedCategory
    ? `Your multipurpose Discord assistant.\n**Kategori:** ${selectedCategory.emoji} ${selectedCategory.label} — ${selectedCategory.description}`
    : 'Your multipurpose Discord assistant.\nDiscover Midwave\'s features and commands in one place.';

  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('MIDWAVE — COMMAND GUIDE')
    .setDescription(description);

  if (fs.existsSync(MENU_ICON_PATH)) {
    embed.setThumbnail(MENU_ICON_ATTACHMENT_URL);
  } else if (fs.existsSync(LOGO_PATH)) {
    embed.setThumbnail(LOGO_ATTACHMENT_URL);
  }

  const targetCategories = selectedCategory ? [selectedCategory] : HELP_CATEGORIES;
  let runningLength = embed.data.title.length + embed.data.description.length;

  for (const category of targetCategories) {
    const categoryEntries = resolvedEntries.filter((entry) => entry.category === category.key);
    if (categoryEntries.length === 0) {
      continue;
    }

    const categoryItems = [];
    const seenItems = new Set();
    for (const entry of categoryEntries) {
      const list = Array.isArray(entry.items) && entry.items.length > 0 ? entry.items : [entry.id];
      for (const item of list) {
        if (!seenItems.has(item)) {
          seenItems.add(item);
          categoryItems.push(item);
        }
      }
    }

    const fieldName = `${category.emoji} ${category.label} (${categoryItems.length})`;
    const rawValue = categoryItems.map((name) => `\`${name}\``).join(', ');
    const remainingBudget = MAX_EMBED_TOTAL_LENGTH - runningLength - fieldName.length;
    if (remainingBudget <= 20) {
      break;
    }

    const fieldValue = truncateFieldValue(rawValue, Math.min(MAX_FIELD_LENGTH, remainingBudget));
    embed.addFields({
      name: fieldName,
      value: fieldValue,
      inline: false,
    });
    runningLength += fieldName.length + fieldValue.length;
  }

  return embed;
}

/**
 * Builds the optional category filter StringSelectMenu row for interactive help navigation.
 * @param {object} [options]
 * @returns {ActionRowBuilder<StringSelectMenuBuilder>}
 */
export function buildHelpCategoryMenu({
  selectedCategory = 'all',
  disabled = false,
  customId = HELP_SELECT_CUSTOM_ID,
} = {}) {
  const options = [
    new StringSelectMenuOptionBuilder()
      .setLabel('Semua Kategori')
      .setValue('all')
      .setDescription('Tampilkan seluruh panduan command Midwave')
      .setEmoji('🌊')
      .setDefault(selectedCategory === 'all'),
    ...HELP_CATEGORIES.map((category) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(category.label)
        .setValue(category.key)
        .setDescription(category.description)
        .setEmoji(category.emoji)
        .setDefault(selectedCategory === category.key)
    ),
  ];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('Filter kategori command (opsional)')
    .setDisabled(disabled)
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}
