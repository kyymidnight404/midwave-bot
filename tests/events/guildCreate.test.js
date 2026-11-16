import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import guildCreateEvent from '../../src/events/guildCreate.js';

function createChannelMock({
  id,
  name = 'general',
  type = ChannelType.GuildText,
  position = 0,
  canSend = true,
  canAttach = true,
}) {
  const sentMessages = [];
  return {
    id,
    name,
    type,
    position,
    sentMessages,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => {
      const bits = [];
      if (canSend) {
        bits.push(
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        );
      }
      if (canAttach) {
        bits.push(PermissionFlagsBits.AttachFiles);
      }
      return new PermissionsBitField(bits);
    },
    async send(payload) {
      sentMessages.push(payload);
      return { id: `msg-${sentMessages.length}`, payload };
    },
  };
}

describe('Bot Guild Join Auto-Embed (guildCreate)', () => {
  it('sends an automatic footer-free welcome embed with join.png to systemChannel when permitted', async () => {
    const sysChannel = createChannelMock({ id: 'sys-1', canSend: true, canAttach: true });
    const guild = {
      id: 'guild-1',
      name: 'Midwave Server',
      systemChannel: sysChannel,
      channels: { cache: new Map([[sysChannel.id, sysChannel]]) },
      members: { me: { id: 'bot-1' } },
    };

    await guildCreateEvent.execute(guild, { prefix: '!' });

    assert.equal(sysChannel.sentMessages.length, 1);
    const payload = sysChannel.sentMessages[0];
    const embedJson = payload.embeds[0].toJSON();
    assert.match(embedJson.title, /Midwave Server/);
    assert.equal(embedJson.thumbnail?.url, 'attachment://join.png');
    assert.equal(embedJson.footer, undefined);
    assert.equal(embedJson.timestamp, undefined);
    assert.ok(payload.files.some((f) => f.name === 'join.png'));
  });

  it('falls back to the first writable text channel and omits file attachment if AttachFiles is denied', async () => {
    const lockedSys = createChannelMock({ id: 'sys-locked', canSend: false, canAttach: false });
    const general = createChannelMock({
      id: 'gen-1',
      position: 0,
      canSend: true,
      canAttach: false,
    });
    const guild = {
      id: 'guild-2',
      name: 'Fallback Guild',
      systemChannel: lockedSys,
      channels: {
        cache: new Map([
          [lockedSys.id, lockedSys],
          [general.id, general],
        ]),
      },
      members: { me: { id: 'bot-1' } },
    };

    await guildCreateEvent.execute(guild, { prefix: '?' });

    assert.equal(lockedSys.sentMessages.length, 0);
    assert.equal(general.sentMessages.length, 1);
    const payload = general.sentMessages[0];
    const embedJson = payload.embeds[0].toJSON();
    assert.equal(embedJson.thumbnail, undefined);
    assert.deepEqual(payload.files, []);
    assert.match(embedJson.description, /\?menu/);
  });
});
