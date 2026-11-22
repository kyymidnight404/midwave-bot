import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { EMOJIS } from '../../src/config/emojis.js';
import { createBotApp } from '../../src/index.js';
import { execute as executeServers, SERVERS_OWNER_ONLY_MESSAGE } from '../../src/prefixCommands/servers.js';
import {
  SERVERS_PER_PAGE,
  buildServersEmbed,
  buildServersPaginationRow,
  extractBotServers,
  paginateServers,
} from '../../src/services/serversService.js';
import { discoverHelpEntries } from '../../src/services/helpService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

const OWNER_ID = '111222333444555666';
const NON_OWNER_ID = '999888777666555444';

function createFakeGuild(index, overrides = {}) {
  const num = index + 1;
  return {
    id: String(100000000000000000n + BigInt(num)),
    name: `Server ${num}`,
    memberCount: num * 10,
    iconURL: () => `https://cdn.discordapp.com/icons/${100000000000000000n + BigInt(num)}/icon_${num}.png`,
    ...overrides,
  };
}

function createFakeGuildCache(guilds) {
  const map = new Map(guilds.map((g) => [g.id, g]));
  return map;
}

function createFakePrefixMessage({ content, userId, client }) {
  const sentMessages = [];
  const channelMessages = [];

  const trackSent = (payload) => {
    const msg = {
      id: `msg-${sentMessages.length + 1}`,
      payload,
    };
    sentMessages.push(msg);
    return msg;
  };

  return {
    id: `trigger-${Math.random().toString(36).slice(2, 8)}`,
    content,
    author: {
      id: userId,
      bot: false,
      username: `user-${userId}`,
    },
    client,
    guild: {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
    },
    channel: {
      id: 'ch-servers-1',
      isTextBased: () => true,
      permissionsFor: () =>
        new Set([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]),
      async sendTyping() {},
      async send(payload) {
        channelMessages.push(payload);
        return trackSent(payload);
      },
    },
    async reply(payload) {
      return trackSent(payload);
    },
    getSentMessages: () => sentMessages,
    getChannelSendCount: () => channelMessages.length,
  };
}

function createFakeButtonInteraction({ customId, userId, client }) {
  const events = [];
  return {
    customId,
    user: { id: userId },
    client,
    isButton: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    async update(payload) {
      events.push({ type: 'update', payload });
      return payload;
    },
    async reply(payload) {
      events.push({ type: 'reply', payload });
      return payload;
    },
    getEvents: () => events,
  };
}

describe('!servers / !guilds — Owner Server List & Pagination', () => {
  it('parses !servers and !guilds alias and hides command from !menu, /help, public help & slash commands', async () => {
    assert.deepEqual(parsePrefixInvocation('!servers'), {
      commandName: 'servers',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('!guilds'), {
      commandName: 'servers',
      subcommand: null,
      options: {},
    });

    const regularHelp = discoverHelpEntries({ prefix: '!', memberPermissions: null });
    const adminHelp = discoverHelpEntries({
      prefix: '!',
      memberPermissions: PermissionFlagsBits.Administrator,
    });
    assert.equal(regularHelp.some((e) => e.items?.includes('servers') || e.items?.includes('guilds')), false);
    assert.equal(adminHelp.some((e) => e.items?.includes('servers') || e.items?.includes('guilds')), false);

    const prevEnv = process.env.BOT_OWNER_IDS;
    process.env.BOT_OWNER_IDS = OWNER_ID;
    const app = await createBotApp({
      cooldowns: new CooldownManager(0),
      skipTempCleanup: true,
    });

    try {
      assert.equal(app.commandHandler.get('servers'), undefined);

      // Execute !menu as Bot Owner with Administrator permissions -> servers & guilds still hidden
      const menuMsg = createFakePrefixMessage({
        content: '!menu',
        userId: OWNER_ID,
        client: app.client,
      });
      menuMsg.member = { permissions: PermissionFlagsBits.Administrator };
      menuMsg.channel.permissionsFor = () =>
        new Set([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ]);
      await app.prefixCommandHandler.handle(menuMsg);

      const menuSent = menuMsg.getSentMessages();
      assert.equal(menuSent.length, 1);
      const menuSerialized = JSON.stringify(menuSent[0].payload.embeds[0].toJSON()).toLowerCase();
      assert.equal(menuSerialized.includes('servers'), false);
      assert.equal(menuSerialized.includes('guilds'), false);
      assert.ok(menuSerialized.includes('`menu`'));
      assert.ok(menuSerialized.includes('`pin`'));
      assert.ok(menuSerialized.includes('`download`'));

      // Execute /help -> servers & guilds hidden, other commands intact
      const helpReplies = [];
      await app.interactionHandler.handle({
        commandName: 'help',
        user: { id: OWNER_ID },
        memberPermissions: PermissionFlagsBits.Administrator,
        deferred: false,
        replied: false,
        isChatInputCommand: () => true,
        isMessageContextMenuCommand: () => false,
        options: {
          getSubcommand: () => null,
          getSubcommandGroup: () => null,
          getString: () => null,
        },
        async reply(payload) {
          this.replied = true;
          helpReplies.push(payload);
        },
      });
      assert.equal(helpReplies.length, 1);
      const helpSerialized = JSON.stringify(helpReplies[0].embeds[0].toJSON()).toLowerCase();
      assert.equal(helpSerialized.includes('servers'), false);
      assert.equal(helpSerialized.includes('guilds'), false);
      assert.ok(helpSerialized.includes('`menu`'));
    } finally {
      if (prevEnv === undefined) {
        delete process.env.BOT_OWNER_IDS;
      } else {
        process.env.BOT_OWNER_IDS = prevEnv;
      }
      app.shutdown();
    }
  });

  it('rejects non-owners ephemerally before accessing client.guilds.cache', async () => {
    let cacheAccessed = false;
    const fakeClient = {
      guilds: {
        get cache() {
          cacheAccessed = true;
          return new Map();
        },
      },
    };

    const replies = [];
    const mockInteraction = {
      user: { id: NON_OWNER_ID, bot: false },
      client: fakeClient,
      options: { getString: () => null },
      async reply(payload) {
        replies.push(payload);
      },
    };

    await executeServers(mockInteraction, {
      client: fakeClient,
      env: { BOT_OWNER_IDS: OWNER_ID },
    });

    assert.equal(cacheAccessed, false, 'client.guilds.cache must not be read for unauthorized users');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(replies[0].embeds[0].toJSON().description, SERVERS_OWNER_ONLY_MESSAGE);

    // Also fail-closed when BOT_OWNER_IDS is unset/empty
    const emptyEnvReplies = [];
    await executeServers(
      {
        user: { id: OWNER_ID, bot: false },
        client: fakeClient,
        options: { getString: () => null },
        async reply(payload) {
          emptyEnvReplies.push(payload);
        },
      },
      { client: fakeClient, env: {} },
    );
    assert.equal(cacheAccessed, false);
    assert.equal(emptyEnvReplies[0].flags, MessageFlags.Ephemeral);
    assert.equal(emptyEnvReplies[0].embeds[0].toJSON().description, SERVERS_OWNER_ONLY_MESSAGE);
  });

  it('handles zero servers and missing iconURL / memberCount safely', () => {
    // 0 servers
    const emptySnapshot = extractBotServers({ guilds: { cache: new Map() } });
    assert.equal(emptySnapshot.totalServers, 0);
    assert.equal(emptySnapshot.totalMembers, null);
    const emptyPaginated = paginateServers(emptySnapshot.servers, 0);
    assert.equal(emptyPaginated.totalPages, 1);
    const emptyEmbed = buildServersEmbed({
      ...emptyPaginated,
      totalServers: emptySnapshot.totalServers,
      totalMembers: emptySnapshot.totalMembers,
    }).toJSON();
    assert.equal(emptyEmbed.title, `${EMOJIS.users} Midwave — Server List`);
    assert.match(emptyEmbed.description, /Total Servers: \*\*0\*\*/);
    assert.equal(emptyEmbed.footer.text, 'Page 1/1 • MIDWAVE');

    // Missing iconURL and missing memberCount
    const partialGuilds = [
      { id: '111', name: 'No Meta Guild', memberCount: undefined, iconURL: () => null },
      { id: '222', name: 'Only Members Guild', memberCount: 42, iconURL: null },
      {
        id: '333',
        name: 'Broken Icon Fn Guild',
        memberCount: null,
        iconURL: () => {
          throw new Error('icon error');
        },
      },
    ];
    const partialSnapshot = extractBotServers({ guilds: { cache: createFakeGuildCache(partialGuilds) } });
    assert.equal(partialSnapshot.totalServers, 3);
    assert.equal(partialSnapshot.totalMembers, 42);
    assert.equal(partialSnapshot.servers[0].memberCount, null);
    assert.equal(partialSnapshot.servers[0].iconUrl, null);
    assert.equal(partialSnapshot.servers[2].iconUrl, null);

    const partialEmbed = buildServersEmbed({
      ...paginateServers(partialSnapshot.servers, 0),
      totalServers: partialSnapshot.totalServers,
      totalMembers: partialSnapshot.totalMembers,
    }).toJSON();
    assert.match(partialEmbed.description, /No Meta Guild/);
    assert.match(partialEmbed.description, /Only Members Guild/);
    assert.match(partialEmbed.description, /Members: 42/);
    assert.equal(partialEmbed.description.includes('undefined'), false);
    assert.equal(partialEmbed.description.includes('null'), false);
    assert.equal(partialEmbed.description.includes('CPU'), false);
    assert.equal(partialEmbed.description.includes('RAM'), false);
  });

  it('builds Previous and Next pagination buttons with exact disabled states', () => {
    const firstRow = buildServersPaginationRow({
      currentPage: 0,
      totalPages: 3,
      ownerId: OWNER_ID,
    }).toJSON();
    assert.equal(firstRow.components.length, 2);
    assert.equal(firstRow.components[0].label, 'Previous');
    assert.equal(firstRow.components[0].style, ButtonStyle.Secondary);
    assert.equal(firstRow.components[0].disabled, true);
    assert.equal(firstRow.components[1].label, 'Next');
    assert.equal(firstRow.components[1].style, ButtonStyle.Secondary);
    assert.equal(firstRow.components[1].disabled, false);

    const middleRow = buildServersPaginationRow({
      currentPage: 1,
      totalPages: 3,
      ownerId: OWNER_ID,
    }).toJSON();
    assert.equal(middleRow.components[0].disabled, false);
    assert.equal(middleRow.components[1].disabled, false);

    const lastRow = buildServersPaginationRow({
      currentPage: 2,
      totalPages: 3,
      ownerId: OWNER_ID,
    }).toJSON();
    assert.equal(lastRow.components[0].disabled, false);
    assert.equal(lastRow.components[1].disabled, true);

    const singleRow = buildServersPaginationRow({
      currentPage: 0,
      totalPages: 1,
      ownerId: OWNER_ID,
    }).toJSON();
    assert.equal(singleRow.components[0].disabled, true);
    assert.equal(singleRow.components[1].disabled, true);
  });

  it('executes !servers and !guilds for Bot Owner with 10-per-page pagination via interaction.update()', async () => {
    assert.equal(SERVERS_PER_PAGE, 10);

    const guilds = Array.from({ length: 23 }, (_, i) => createFakeGuild(i));
    const expectedTotalMembers = guilds.reduce((sum, g) => sum + g.memberCount, 0);

    const fakeClient = {
      user: { id: 'bot-1' },
      guilds: { cache: createFakeGuildCache(guilds) },
      once() {},
      on() {},
      destroy() {},
    };

    const prevEnv = process.env.BOT_OWNER_IDS;
    process.env.BOT_OWNER_IDS = OWNER_ID;

    const app = await createBotApp({
      client: fakeClient,
      cooldowns: new CooldownManager(0),
      skipTempCleanup: true,
    });

    try {
      // 1. Non-owner rejected via PrefixCommandHandler
      const nonOwnerMsg = createFakePrefixMessage({
        content: '!servers',
        userId: NON_OWNER_ID,
        client: fakeClient,
      });
      await app.prefixCommandHandler.handle(nonOwnerMsg);
      const nonOwnerSent = nonOwnerMsg.getSentMessages();
      assert.equal(nonOwnerSent.length, 1);
      assert.equal(nonOwnerSent[0].payload.embeds[0].toJSON().description, SERVERS_OWNER_ONLY_MESSAGE);

      // 2. Owner runs !servers -> Page 1/3 (servers 1..10)
      const ownerMsg = createFakePrefixMessage({
        content: '!servers',
        userId: OWNER_ID,
        client: fakeClient,
      });
      await app.prefixCommandHandler.handle(ownerMsg);
      const sent = ownerMsg.getSentMessages();
      assert.equal(sent.length, 1);

      const page1Embed = sent[0].payload.embeds[0].toJSON();
      assert.equal(page1Embed.title, `${EMOJIS.users} Midwave — Server List`);
      assert.match(page1Embed.description, /Total Servers: \*\*23\*\*/);
      assert.match(page1Embed.description, new RegExp(`Total Members: \\*\\*${expectedTotalMembers.toLocaleString('en-US')}\\*\\*`));
      assert.match(page1Embed.description, /1\. \*\*Server 1\*\*/);
      assert.match(page1Embed.description, /10\. \*\*Server 10\*\*/);
      assert.equal(page1Embed.description.includes('11. **Server 11**'), false);
      assert.equal(page1Embed.footer.text, 'Page 1/3 • MIDWAVE');
      assert.equal(page1Embed.thumbnail.url, guilds[0].iconURL());

      const row1 = sent[0].payload.components[0].toJSON();
      assert.equal(row1.components[0].disabled, true);
      assert.equal(row1.components[1].disabled, false);

      const next1CustomId = row1.components[1].custom_id;

      // 3. Non-owner clicks Next -> rejected ephemerally, no update, no new message
      const intruderBtn = createFakeButtonInteraction({
        customId: next1CustomId,
        userId: NON_OWNER_ID,
        client: fakeClient,
      });
      await app.interactionHandler.handle(intruderBtn);
      assert.equal(intruderBtn.getEvents().length, 1);
      assert.equal(intruderBtn.getEvents()[0].type, 'reply');
      assert.equal(intruderBtn.getEvents()[0].payload.flags, MessageFlags.Ephemeral);
      assert.equal(intruderBtn.getEvents()[0].payload.embeds[0].toJSON().description, SERVERS_OWNER_ONLY_MESSAGE);

      // 4. Owner clicks Next -> Page 2/3 (servers 11..20) via interaction.update()
      const nextBtn1 = createFakeButtonInteraction({
        customId: next1CustomId,
        userId: OWNER_ID,
        client: fakeClient,
      });
      await app.interactionHandler.handle(nextBtn1);
      const page2Events = nextBtn1.getEvents();
      assert.equal(page2Events.length, 1);
      assert.equal(page2Events[0].type, 'update');
      assert.equal(ownerMsg.getSentMessages().length, 1); // No new message sent!

      const page2Embed = page2Events[0].payload.embeds[0].toJSON();
      assert.match(page2Embed.description, /11\. \*\*Server 11\*\*/);
      assert.match(page2Embed.description, /20\. \*\*Server 20\*\*/);
      assert.equal(page2Embed.footer.text, 'Page 2/3 • MIDWAVE');

      const row2 = page2Events[0].payload.components[0].toJSON();
      assert.equal(row2.components[0].disabled, false);
      assert.equal(row2.components[1].disabled, false);

      // 5. Owner clicks Next -> Page 3/3 (servers 21..23), Next disabled
      const nextBtn2 = createFakeButtonInteraction({
        customId: row2.components[1].custom_id,
        userId: OWNER_ID,
        client: fakeClient,
      });
      await app.interactionHandler.handle(nextBtn2);
      const page3Events = nextBtn2.getEvents();
      assert.equal(page3Events[0].type, 'update');
      const page3Embed = page3Events[0].payload.embeds[0].toJSON();
      assert.match(page3Embed.description, /21\. \*\*Server 21\*\*/);
      assert.match(page3Embed.description, /23\. \*\*Server 23\*\*/);
      assert.equal(page3Embed.footer.text, 'Page 3/3 • MIDWAVE');

      const row3 = page3Events[0].payload.components[0].toJSON();
      assert.equal(row3.components[0].disabled, false);
      assert.equal(row3.components[1].disabled, true);

      // 6. Owner clicks Previous -> returns to Page 2/3
      const prevBtn = createFakeButtonInteraction({
        customId: row3.components[0].custom_id,
        userId: OWNER_ID,
        client: fakeClient,
      });
      await app.interactionHandler.handle(prevBtn);
      const backEvents = prevBtn.getEvents();
      assert.equal(backEvents[0].type, 'update');
      assert.equal(backEvents[0].payload.embeds[0].toJSON().footer.text, 'Page 2/3 • MIDWAVE');

      // 7. !guilds alias works identically
      const aliasMsg = createFakePrefixMessage({
        content: '!guilds',
        userId: OWNER_ID,
        client: fakeClient,
      });
      await app.prefixCommandHandler.handle(aliasMsg);
      assert.equal(aliasMsg.getSentMessages().length, 1);
      assert.equal(aliasMsg.getSentMessages()[0].payload.embeds[0].toJSON().title, `${EMOJIS.users} Midwave — Server List`);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.BOT_OWNER_IDS;
      } else {
        process.env.BOT_OWNER_IDS = prevEnv;
      }
      app.shutdown();
    }
  });
});
