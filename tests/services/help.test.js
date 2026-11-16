import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import '../../src/handlers/PrefixCommandHandler.js';
import helpCommand from '../../src/commands/help.js';
import {
  buildDynamicHelpEmbed,
  buildHelpCategoryMenu,
  discoverHelpEntries,
} from '../../src/services/helpService.js';
import { buildHelpEmbed } from '../../src/utils/embeds.js';
import { COLORS, EMBED_FOOTER, LOGO_ATTACHMENT_URL } from '../../src/utils/constants.js';
import defaultCommandStructure from '../../src/config/commandStructure.js';
import { DEFAULT_HANDLER_REGISTRY } from '../../src/config/commandRegistry.js';

test('Help Embed: single embed with Midnight Ocean visual identity & all 5 categories', () => {
  const entries = discoverHelpEntries({ prefix: '!' });
  const embed = buildDynamicHelpEmbed({ entries, prefix: '!' });
  const json = embed.toJSON();

  assert.equal(json.title, 'MIDWAVE — COMMAND GUIDE');
  assert.ok(json.description.includes('Your multipurpose Discord assistant.'));
  assert.ok(json.description.includes("Discover Midwave's features and commands in one place."));
  assert.equal(json.color, COLORS.PRIMARY);
  assert.equal(json.thumbnail?.url, 'attachment://menu.png');
  assert.equal(json.footer, undefined);

  const fieldNames = json.fields.map((f) => f.name);
  assert.equal(new Set(fieldNames).size, 5);
  assert.ok(fieldNames.some((n) => n.startsWith('<:bot:1571472389592584344> AI & Knowledge')));
  assert.ok(fieldNames.some((n) => n.startsWith('<:game:1571472414875844618> Mini Games')));
  assert.ok(fieldNames.some((n) => n.startsWith('<:star:1571472439962107985> Social Interactions (11)')));
  assert.ok(fieldNames.some((n) => n.startsWith('<:tools:1571472462787641414> Media & Utilities')));
  assert.ok(fieldNames.some((n) => n.startsWith('<:pin:1571472304645345300> General')));

  const socialField = json.fields.find((f) => f.name.includes('Social Interactions'));
  assert.ok(socialField);
  assert.equal(socialField.value.includes('`social`'), false);
  assert.equal(
    socialField.value,
    ['hug', 'pat', 'slap', 'bonk', 'kick', 'poke', 'yeet', 'highfive', 'wave', 'laugh', 'cry']
      .map((name) => `\`${name}\``)
      .join(', '),
  );
});

test('Help Embed: renders compact category counts and inline command pills for all active commands', () => {
  const entries = discoverHelpEntries({ prefix: '?' });
  const json = buildDynamicHelpEmbed({ entries, prefix: '?' }).toJSON();
  const serialized = JSON.stringify(json);

  assert.ok(json.fields.every((f) => /\(\d+\)$/.test(f.name)));
  assert.ok(serialized.includes('`brat`'));
  assert.ok(serialized.includes('`download`'));
  assert.ok(serialized.includes('`qc`'));
  assert.ok(serialized.includes('`lyrics`'));
  assert.ok(serialized.includes('`coinflip`'));
  assert.ok(serialized.includes('`rps`'));
  assert.ok(serialized.includes('`tictactoe`'));
  assert.ok(serialized.includes('`quiz`'));
  assert.ok(serialized.includes('`say`'));
  assert.ok(serialized.includes('`igf`'));
  assert.ok(serialized.includes('`menu`'));
  assert.equal(serialized.includes('`help`'), false);
  assert.equal(serialized.includes('`Generate QC`'), false);
  assert.equal(serialized.includes('`game`'), false);
  assert.equal(serialized.includes('`games`'), false);
  assert.equal(serialized.includes('`invite`'), false);
  assert.equal(serialized.includes('`dice`'), false);
  assert.equal(serialized.includes('`guess`'), false);
  assert.equal(serialized.includes('`connect4`'), false);
});

test('Help Discovery: excludes disabled commands and commands without valid handlers', () => {
  const customStructure = {
    environment: 'test',
    commands: [
      {
        name: 'disabled_cmd',
        description: 'Should not appear',
        enabled: false,
        type: 'standalone',
        handler: 'help',
        help: { category: 'general', usage: 'disabled_cmd' },
      },
      {
        name: 'broken_cmd',
        description: 'Missing handler',
        enabled: true,
        type: 'standalone',
        handler: 'non_existent_handler_xyz',
        help: { category: 'general', usage: 'broken_cmd' },
      },
      {
        name: 'help',
        description: 'Active help',
        enabled: true,
        type: 'standalone',
        handler: 'help',
        help: { category: 'general', usage: 'help', prefixUsage: '{prefix}help' },
      },
    ],
  };

  const entries = discoverHelpEntries({
    commandStructure: customStructure,
    handlerRegistry: DEFAULT_HANDLER_REGISTRY,
    registeredPrefixCommands: new Set(['help']),
    prefix: '!',
  });

  const text = entries.map((e) => e.line).join('\n');
  assert.equal(text.includes('disabled_cmd'), false);
  assert.equal(text.includes('broken_cmd'), false);
  assert.ok(text.includes('/help'));
});

test('Help Discovery: excludes commands not registered in CommandHandler.commands when provided', () => {
  const mockCommandHandler = {
    commands: new Map([['help', { data: {} }]]),
  };

  const entries = discoverHelpEntries({
    commandHandler: mockCommandHandler,
    prefix: '!',
  });

  const ids = entries.map((e) => e.id);
  assert.ok(ids.includes('command:help'));
  assert.equal(ids.includes('command:ai'), false);
});

test('Help Privacy: !knowledge hidden from normal users and visible to Administrator', () => {
  const regularEntries = discoverHelpEntries({
    memberPermissions: null,
    prefix: '!',
  });
  const adminEntries = discoverHelpEntries({
    memberPermissions: PermissionFlagsBits.Administrator,
    prefix: '!',
  });

  assert.equal(regularEntries.some((e) => e.id === 'command:knowledge'), false);
  assert.equal(adminEntries.some((e) => e.id === 'command:knowledge'), false);
  assert.equal(
    regularEntries.some((e) => e.id === 'prefix:knowledge'),
    false
  );
  assert.equal(
    adminEntries.some((e) => e.id === 'prefix:knowledge'),
    true
  );
});

test('Help Privacy: internal visibility commands are hidden even from Administrators', () => {
  const customStructure = {
    environment: 'test',
    commands: [
      {
        name: 'internal_debug',
        description: 'Internal only',
        enabled: true,
        type: 'standalone',
        handler: 'help',
        help: { category: 'general', visibility: 'internal', usage: 'internal_debug' },
      },
    ],
  };

  const entries = discoverHelpEntries({
    commandStructure: customStructure,
    memberPermissions: PermissionFlagsBits.Administrator,
    registeredPrefixCommands: new Set(),
  });

  assert.equal(entries.length, 0);
});

test('Help Metadata: dynamically includes newly enabled custom command without hardcoding', () => {
  const customStructure = {
    environment: 'test',
    commands: [
      ...defaultCommandStructure.commands,
      {
        name: 'ping',
        description: 'Cek latensi bot Midwave',
        enabled: true,
        type: 'standalone',
        handler: 'help',
        help: { category: 'general', usage: 'ping', description: 'Cek latensi bot Midwave' },
      },
    ],
  };

  const entries = discoverHelpEntries({
    commandStructure: customStructure,
    prefix: '!',
  });
  const text = entries.map((e) => e.line).join('\n');
  assert.ok(text.includes('/ping'));
  assert.ok(text.includes('Cek latensi bot Midwave'));
});

test('Help Content: includes all 10 social actions and all mini-games without duplicates', () => {
  const entries = discoverHelpEntries({ prefix: '!' });
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);

  const text = entries.map((e) => e.line).join('\n');
  for (const action of ['hug', 'pat', 'slap', 'bonk', 'poke', 'yeet', 'highfive', 'wave', 'laugh', 'cry']) {
    assert.ok(text.includes(action), `Missing social action: ${action}`);
  }
  for (const game of ['coinflip', 'rps', 'tictactoe', 'quiz']) {
    assert.ok(text.includes(game), `Missing game: ${game}`);
  }
});

test('Help Command: sends embed without category select menu components', async () => {
  const replies = [];
  const mockInteraction = {
    user: { id: 'owner-1' },
    memberPermissions: null,
    reply: async (payload) => {
      replies.push(payload);
      return {};
    },
  };

  await helpCommand.execute(mockInteraction, { prefix: '!' });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds.length, 1);
  assert.equal(replies[0].components, undefined);
});

test('Help Embed & SelectMenu: respects Discord embed length & component limits', () => {
  const embedJson = buildHelpEmbed('!').toJSON();
  assert.ok(embedJson.fields.length <= 25);

  let totalChars = (embedJson.title?.length || 0) + (embedJson.description?.length || 0);
  for (const field of embedJson.fields) {
    assert.ok(field.name.length <= 256);
    assert.ok(field.value.length <= 1024);
    totalChars += field.name.length + field.value.length;
  }
  assert.ok(totalChars <= 6000);

  const menuRow = buildHelpCategoryMenu().toJSON();
  assert.equal(menuRow.components[0].type, 3);
  assert.equal(menuRow.components[0].options.length, 6);
});
