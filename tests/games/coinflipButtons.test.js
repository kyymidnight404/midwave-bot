import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createFakeChannel(id = 'ch-cf-1') {
  const sent = [];
  let seq = 100;
  const makeMsg = (msgId, payload) => {
    const msg = {
      id: msgId,
      channelId: id,
      payload,
      edits: [],
      async edit(next) {
        this.payload = { ...this.payload, ...next };
        this.edits.push(next);
        return this;
      },
    };
    return msg;
  };

  return {
    id,
    sent,
    isTextBased: () => true,
    messages: {
      async fetch(msgId) {
        const found = sent.find((m) => m.id === msgId);
        if (!found) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return found;
      },
    },
    async send(payload) {
      const m = makeMsg(String(++seq), payload);
      sent.push(m);
      return m;
    },
  };
}

function createFakeClient(channel) {
  return {
    channels: {
      async fetch(channelId) {
        return channelId === channel.id ? channel : null;
      },
    },
    on() {},
    once() {},
    destroy() {},
  };
}

function createPrefixMessage({ content, author, channel, mentions = [], client }) {
  const replies = [];
  let seq = 500;
  const userMap = new Map(mentions.map((u) => [u.id, u]));

  return {
    id: String(++seq),
    content,
    author,
    guildId: 'guild-cf-1',
    channelId: channel.id,
    channel,
    client,
    mentions: {
      users: {
        get: (id) => userMap.get(id),
        has: (id) => userMap.has(id),
        first: () => mentions[0],
      },
    },
    getReplies: () => replies,
    async reply(payload) {
      const msg = {
        id: String(++seq),
        channelId: channel.id,
        payload,
        edits: [],
        async edit(next) {
          this.payload = { ...this.payload, ...next };
          this.edits.push(next);
          return this;
        },
      };
      channel.sent.push(msg);
      replies.push(msg);
      return msg;
    },
  };
}

function createButtonInteraction({ customId, user, message, channel, client }) {
  const responses = [];
  let msgSeq = 900;
  return {
    customId,
    user,
    guildId: 'guild-cf-1',
    channelId: channel.id,
    channel,
    message,
    client,
    deferred: false,
    replied: false,
    isButton: () => true,
    isChatInputCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    getResponses: () => responses,
    async update(payload) {
      this.replied = true;
      await message.edit(payload);
      responses.push({ type: 'update', payload });
      return message;
    },
    async deferReply(opts = {}) {
      this.deferred = true;
      responses.push({ type: 'deferReply', opts });
    },
    async reply(payload) {
      this.replied = true;
      responses.push({ type: 'reply', payload });
      return message;
    },
    async editReply(payload) {
      responses.push({ type: 'editReply', payload });
      return message;
    },
    async followUp(payload) {
      const msg = {
        id: String(++msgSeq),
        channelId: channel.id,
        payload,
        edits: [],
        async edit(next) {
          this.payload = { ...this.payload, ...next };
          this.edits.push(next);
          return this;
        },
      };
      channel.sent.push(msg);
      responses.push({ type: 'followUp', payload, message: msg });
      return msg;
    },
  };
}

describe('CoinFlip Interactive Button Flow', () => {
  it('supports Accept and Reject buttons on !coinflip @user challenge and Heads/Tails buttons for secret choices', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const app = await createBotApp({ client, prisma: {}, cooldowns: new CooldownManager(0) });

    const p1 = { id: '100000000000000001', username: 'kyy', bot: false };
    const p2 = { id: '100000000000000002', username: 'caffeine', bot: false };
    const outsider = { id: '100000000000000003', username: 'outsider', bot: false };

    try {
      // 1. Challenge posts Accept and Reject buttons
      const challengeMsg = createPrefixMessage({
        content: `!coinflip <@${p2.id}>`,
        author: p1,
        channel,
        mentions: [p2],
        client,
      });
      await app.prefixCommandHandler.handle(challengeMsg);
      const lobbyMsg = challengeMsg.getReplies()[0];
      const lobbyJson = lobbyMsg.payload.embeds[0].toJSON();
      assert.equal(lobbyJson.fields, undefined);
      assert.match(lobbyJson.description, /Menunggu Konfirmasi/);
      const lobbyButtons = lobbyMsg.payload.components[0].components;
      assert.equal(lobbyButtons.length, 2);
      assert.equal(lobbyButtons[0].data.label, 'Accept');
      assert.equal(lobbyButtons[1].data.label, 'Reject');

      const acceptId = lobbyButtons[0].data.custom_id;
      const rejectId = lobbyButtons[1].data.custom_id;

      // Outsider cannot accept
      const outsiderAccept = createButtonInteraction({
        customId: acceptId,
        user: outsider,
        message: lobbyMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(outsiderAccept);
      assert.equal(outsiderAccept.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

      // 2. Opponent rejects -> lobby updated, buttons removed
      const rejectInt = createButtonInteraction({
        customId: rejectId,
        user: p2,
        message: lobbyMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(rejectInt);
      assert.deepEqual(lobbyMsg.payload.components, []);
      assert.equal(app.inviteManager.getIncomingInvite(p2.id), undefined);
      const rejectedJson = lobbyMsg.payload.embeds[0].toJSON();
      assert.equal(rejectedJson.fields, undefined);
      assert.match(rejectedJson.description, /Ditolak/);

      // 3. New challenge -> Opponent clicks Accept -> Heads / Tails buttons posted
      const challengeMsg2 = createPrefixMessage({
        content: `!coinflip <@${p2.id}>`,
        author: p1,
        channel,
        mentions: [p2],
        client,
      });
      await app.prefixCommandHandler.handle(challengeMsg2);
      const lobbyMsg2 = challengeMsg2.getReplies()[0];
      const acceptId2 = lobbyMsg2.payload.components[0].components[0].data.custom_id;

      const acceptInt = createButtonInteraction({
        customId: acceptId2,
        user: p2,
        message: lobbyMsg2,
        channel,
        client,
      });
      await app.interactionHandler.handle(acceptInt);
      assert.deepEqual(lobbyMsg2.payload.components, []);

      const followUpRes = acceptInt.getResponses().find((r) => r.type === 'followUp');
      assert.ok(followUpRes);
      const boardMsg = followUpRes.message;
      const choiceButtons = boardMsg.payload.components[0].components;
      assert.equal(choiceButtons.length, 2);
      assert.equal(choiceButtons[0].data.label, 'Heads');
      assert.equal(choiceButtons[1].data.label, 'Tails');

      const headsId = choiceButtons[0].data.custom_id;
      const tailsId = choiceButtons[1].data.custom_id;

      // Outsider cannot choose
      const outsiderChoose = createButtonInteraction({
        customId: headsId,
        user: outsider,
        message: boardMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(outsiderChoose);
      assert.equal(outsiderChoose.getResponses()[0].payload.flags, MessageFlags.Ephemeral);

      // 4. Player 1 clicks Heads -> secret locked ephemerally, buttons remain for Player 2
      const p1Heads = createButtonInteraction({
        customId: headsId,
        user: p1,
        message: boardMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(p1Heads);
      assert.equal(p1Heads.getResponses()[0].opts.flags, MessageFlags.Ephemeral);
      assert.equal(boardMsg.payload.components.length, 1);

      // Player 1 duplicate click rejected
      const p1Dup = createButtonInteraction({
        customId: tailsId,
        user: p1,
        message: boardMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(p1Dup);
      assert.ok(p1Dup.getResponses().some((r) => r.payload?.embeds));

      // 5. Player 2 clicks Tails -> game resolves & buttons cleared
      const p2Tails = createButtonInteraction({
        customId: tailsId,
        user: p2,
        message: boardMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(p2Tails);
      assert.deepEqual(boardMsg.payload.components, []);
      assert.equal(app.sessionManager.activeGames.size, 0);
      const resultJson = boardMsg.payload.embeds[0].toJSON();
      assert.equal(resultJson.fields, undefined);
      assert.match(resultJson.description, /Hasil Koin:/);
    } finally {
      app.shutdown();
    }
  });

  it('shows Heads and Tails buttons for solo !coinflip without arguments', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const app = await createBotApp({ client, prisma: {}, cooldowns: new CooldownManager(0) });
    const p1 = { id: '100000000000000001', username: 'kyy', bot: false };

    try {
      const soloMsg = createPrefixMessage({
        content: '!coinflip',
        author: p1,
        channel,
        client,
      });
      await app.prefixCommandHandler.handle(soloMsg);
      const promptMsg = soloMsg.getReplies()[0];
      const buttons = promptMsg.payload.components[0].components;
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].data.label, 'Heads');
      assert.equal(buttons[1].data.label, 'Tails');

      const clickHeads = createButtonInteraction({
        customId: buttons[0].data.custom_id,
        user: p1,
        message: promptMsg,
        channel,
        client,
      });
      await app.interactionHandler.handle(clickHeads);
      assert.deepEqual(promptMsg.payload.components, []);
      const soloResultJson = promptMsg.payload.embeds[0].toJSON();
      assert.equal(soloResultJson.fields, undefined);
      assert.match(soloResultJson.description, /Menang!|Kalah!/);
    } finally {
      app.shutdown();
    }
  });
});
