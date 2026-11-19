import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PermissionFlagsBits } from 'discord.js';
import {
  IGF_ATTACHMENT_NAME,
  IGF_MAX_IMAGE_BYTES,
  IGF_SIZE,
  computeCoverCrop,
  detectSupportedImageFormat,
  fetchValidatedImageBuffer,
  renderInstagramFrame,
  validateImageAttachmentMetadata,
} from '../../src/utils/igfGenerator.js';
import { createBotApp } from '../../src/index.js';
import { CooldownManager } from '../../src/utils/cooldown.js';
import { parsePrefixInvocation } from '../../src/utils/prefixParser.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeSolidImageBuffer(width, height, color, format = 'image/png') {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return c.toBuffer(format);
}

function makeThreeBandImageBuffer(width, height, colors, horizontal = true) {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  const [c1, c2, c3] = colors;
  if (horizontal) {
    ctx.fillStyle = c1;
    ctx.fillRect(0, 0, width / 3, height);
    ctx.fillStyle = c2;
    ctx.fillRect(width / 3, 0, width / 3, height);
    ctx.fillStyle = c3;
    ctx.fillRect((width * 2) / 3, 0, width / 3, height);
  } else {
    ctx.fillStyle = c1;
    ctx.fillRect(0, 0, width, height / 3);
    ctx.fillStyle = c2;
    ctx.fillRect(0, height / 3, width, height / 3);
    ctx.fillStyle = c3;
    ctx.fillRect(0, (height * 2) / 3, width, height / 3);
  }
  return c.toBuffer('image/png');
}

async function readPixel(pngBuffer, x, y) {
  const img = await loadImage(pngBuffer);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(x, y, 1, 1).data;
  return [data[0], data[1], data[2], data[3]];
}

function createFakeMessage({
  content = '!igf',
  attachments = [],
  reference = null,
  referencedMessage = null,
  author = null,
  member = null,
  permissions = null,
} = {}) {
  const replies = [];
  const defaultAuthor = {
    id: 'user-1',
    bot: false,
    username: 'midwave_user',
    globalName: 'Midwave Global',
    avatar: 'custom_hash',
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-1/custom_hash.png?size=256',
  };

  return {
    id: 'msg-100',
    content,
    author: author ?? defaultAuthor,
    member,
    attachments: new Map(attachments.map((att, i) => [String(i), att])),
    reference,
    guild: {
      id: 'guild-1',
      members: {
        me: { id: 'bot-1' },
      },
    },
    channel: {
      id: 'ch-1',
      isTextBased: () => true,
      permissionsFor: () =>
        permissions ??
        new Set([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ]),
      async sendTyping() {},
      messages: {
        async fetch(id) {
          if (referencedMessage && referencedMessage.id === id) {
            return referencedMessage;
          }
          throw new Error('Unknown Message');
        },
      },
    },
    async fetchReference() {
      if (referencedMessage) return referencedMessage;
      throw new Error('Unknown Message');
    },
    async reply(payload) {
      const entry = { type: 'reply', payload };
      replies.push(entry);
      return {
        async edit(editPayload) {
          replies.push({ type: 'edit', payload: editPayload });
          return editPayload;
        },
      };
    },
    getReplies: () => replies,
  };
}

describe('Instagram Post Frame (!igf) utility & prefix command', () => {
  it('parses !igf in prefixParser cleanly with optional caption', () => {
    assert.deepEqual(parsePrefixInvocation('!igf'), {
      commandName: 'igf',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('?IGF', { prefix: '?' }), {
      commandName: 'igf',
      subcommand: null,
      options: {},
    });
    assert.deepEqual(parsePrefixInvocation('!igf jalan sore bareng temen 🌅'), {
      commandName: 'igf',
      subcommand: null,
      options: { caption: 'jalan sore bareng temen 🌅' },
    });
  });

  it('detects PNG, JPEG, GIF, and WebP magic bytes and rejects non-images or unsupported formats', () => {
    const pngBuf = makeSolidImageBuffer(10, 10, '#ff0000', 'image/png');
    const webpBuf = makeSolidImageBuffer(10, 10, '#00ff00', 'image/webp');
    const jpgBuf = makeSolidImageBuffer(10, 10, '#0000ff', 'image/jpeg');
    const gifBuf = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'ascii');
    const bmpBuf = Buffer.from('BM\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'ascii');
    const txtBuf = Buffer.from('hello plain text file', 'utf8');

    assert.equal(detectSupportedImageFormat(pngBuf), 'png');
    assert.equal(detectSupportedImageFormat(webpBuf), 'webp');
    assert.equal(detectSupportedImageFormat(jpgBuf), 'jpeg');
    assert.equal(detectSupportedImageFormat(gifBuf), 'gif');
    assert.equal(detectSupportedImageFormat(bmpBuf), null);
    assert.equal(detectSupportedImageFormat(txtBuf), null);

    assert.throws(
      () => validateImageAttachmentMetadata({ url: 'https://cdn.example.com/doc.pdf', contentType: 'application/pdf', size: 100 }),
      /bukan gambar/i,
    );
    assert.throws(
      () => validateImageAttachmentMetadata({ url: 'https://cdn.example.com/pic.heic', contentType: 'image/heic', size: 100 }),
      /tidak didukung/i,
    );
    assert.throws(
      () => validateImageAttachmentMetadata({ url: 'https://cdn.example.com/huge.png', contentType: 'image/png', size: IGF_MAX_IMAGE_BYTES + 1 }),
      /terlalu besar/i,
    );
  });

  it('computes centered object-fit cover crop rectangles without distortion for portrait, landscape, and square', () => {
    assert.deepEqual(computeCoverCrop(600, 1200, 592, 592), {
      sx: 0,
      sy: 300,
      sw: 600,
      sh: 600,
    });
    assert.deepEqual(computeCoverCrop(1200, 600, 592, 592), {
      sx: 300,
      sy: 0,
      sw: 600,
      sh: 600,
    });
    assert.deepEqual(computeCoverCrop(800, 800, 592, 592), {
      sx: 0,
      sy: 0,
      sw: 800,
      sh: 800,
    });
  });

  it('renders transparent 1080x1080 PNG with portrait, landscape, square, WebP, and Unicode names', async () => {
    const avatarPng = makeSolidImageBuffer(256, 256, '#10b981', 'image/png');

    // Landscape 3-band photo -> center green band (#22c55e) must fill center of 1:1 photo area
    const landscape = makeThreeBandImageBuffer(1200, 600, ['#ef4444', '#22c55e', '#3b82f6'], true);
    const landscapeOut = await renderInstagramFrame({
      photoBuffer: landscape,
      avatarBuffer: avatarPng,
      username: 'kyy',
    });
    assert.ok(landscapeOut.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.equal(landscapeOut.readUInt32BE(16), IGF_SIZE);
    assert.equal(landscapeOut.readUInt32BE(20), IGF_SIZE);

    // Outer corners must be completely transparent (alpha = 0), no gray or checkerboard
    assert.deepEqual(await readPixel(landscapeOut, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(await readPixel(landscapeOut, 1079, 1079), [0, 0, 0, 0]);
    // White card background below photo (near bottom-right corner of card interior)
    const cardWhite = await readPixel(landscapeOut, 820, 960);
    assert.deepEqual(cardWhite, [255, 255, 255, 255]);
    // Center of photo area (540, 466) should reflect middle green band (#22c55e)
    const centerPx = await readPixel(landscapeOut, 540, 466);
    assert.ok(centerPx[1] > centerPx[0] && centerPx[1] > centerPx[2], 'Expected middle green band in cover crop');

    // Portrait 3-band photo
    const portrait = makeThreeBandImageBuffer(600, 1200, ['#ef4444', '#eab308', '#3b82f6'], false);
    const portraitOut = await renderInstagramFrame({
      photoBuffer: portrait,
      avatarBuffer: avatarPng,
      username: 'VeryLongDiscordUsernameThatShouldTruncateCleanly1234567890',
    });
    assert.equal(portraitOut.readUInt32BE(16), IGF_SIZE);
    assert.equal(portraitOut.readUInt32BE(20), IGF_SIZE);

    // Square + WebP photo + Unicode & emoji username + custom multi-line Unicode caption
    const webpSquare = makeSolidImageBuffer(600, 600, '#8b5cf6', 'image/webp');
    const webpOut = await renderInstagramFrame({
      photoBuffer: webpSquare,
      avatarBuffer: avatarPng,
      username: 'kỹy 山田太郎 ✨',
      caption: 'jalan sore menikmati senja di pinggir pantai bareng teman lama 🌅✨',
    });
    assert.equal(webpOut.readUInt32BE(16), IGF_SIZE);
    assert.equal(webpOut.readUInt32BE(20), IGF_SIZE);
    const webpCenter = await readPixel(webpOut, 540, 466);
    assert.ok(webpCenter[2] > 200 && webpCenter[0] > 100, 'Expected purple WebP pixel rendered in photo box');
  });

  it('omits caption block completely (no Lorem ipsum placeholder) when caption is empty or missing', async () => {
    const avatarPng = makeSolidImageBuffer(256, 256, '#10b981', 'image/png');
    const photoPng = makeSolidImageBuffer(600, 600, '#3b82f6', 'image/png');

    const noCaptionUndefined = await renderInstagramFrame({
      photoBuffer: photoPng,
      avatarBuffer: avatarPng,
      username: 'kyy',
    });
    const noCaptionNull = await renderInstagramFrame({
      photoBuffer: photoPng,
      avatarBuffer: avatarPng,
      username: 'kyy',
      caption: null,
    });
    const noCaptionWhitespace = await renderInstagramFrame({
      photoBuffer: photoPng,
      avatarBuffer: avatarPng,
      username: 'kyy',
      caption: '   \n\t  ',
    });
    const withExplicitCaption = await renderInstagramFrame({
      photoBuffer: photoPng,
      avatarBuffer: avatarPng,
      username: 'kyy',
      caption: 'Lorem ipsum dolor sit amet #template',
    });

    assert.ok(noCaptionUndefined.equals(noCaptionNull));
    assert.ok(noCaptionUndefined.equals(noCaptionWhitespace));
    assert.equal(noCaptionUndefined.equals(withExplicitCaption), false);

    // Ensure no blue hashtag (#2B7DE9) pixels are drawn in the caption region when caption is omitted.
    const img = await loadImage(noCaptionUndefined);
    const canvas = createCanvas(IGF_SIZE, IGF_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const region = ctx.getImageData(252, 850, 576, 100).data;
    let blueHashtagPixels = 0;
    for (let i = 0; i < region.length; i += 4) {
      const [r, g, b, a] = [region[i], region[i + 1], region[i + 2], region[i + 3]];
      if (a > 200 && b > 180 && r < 100 && g > 90 && g < 160) {
        blueHashtagPixels += 1;
      }
    }
    assert.equal(blueHashtagPixels, 0);
  });

  it('rejects corrupted images and failed fetches cleanly', async () => {
    const avatarPng = makeSolidImageBuffer(128, 128, '#10b981', 'image/png');
    const corruptedPng = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff])]);

    await assert.rejects(
      () => renderInstagramFrame({ photoBuffer: corruptedPng, avatarBuffer: avatarPng, username: 'kyy' }),
      /rusak/i,
    );

    await assert.rejects(
      () =>
        fetchValidatedImageBuffer('https://cdn.discordapp.com/embed/avatars/0.png', {
          kind: 'avatar',
          fetchFn: async () => ({ ok: false, status: 500 }),
        }),
      /Gagal mengambil avatar Discord/i,
    );
  });

  it('executes !igf end-to-end with direct attachment, reply attachment, default/custom avatar, and error handling', async () => {
    const photoPng = makeSolidImageBuffer(700, 900, '#0284c7', 'image/png');
    const defaultAvatarPng = makeSolidImageBuffer(256, 256, '#5865f2', 'image/png');
    const customAvatarPng = makeSolidImageBuffer(256, 256, '#f43f5e', 'image/png');

    const mockFetch = async (url) => {
      if (url.includes('embed/avatars')) {
        return { ok: true, headers: new Headers(), arrayBuffer: async () => defaultAvatarPng };
      }
      if (url.includes('avatars/user-custom')) {
        return { ok: true, headers: new Headers(), arrayBuffer: async () => customAvatarPng };
      }
      if (url.includes('photo.webp')) {
        const webp = makeSolidImageBuffer(500, 500, '#14b8a6', 'image/webp');
        return { ok: true, headers: new Headers(), arrayBuffer: async () => webp };
      }
      if (url.includes('photo.png')) {
        return { ok: true, headers: new Headers(), arrayBuffer: async () => photoPng };
      }
      return { ok: false, status: 404 };
    };

    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    app.prefixCommandHandler.setContext({ ...app.context, fetchFn: mockFetch });

    // 1. Direct attachment with custom avatar & server nickname
    const msgCustom = createFakeMessage({
      content: '!igf',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: photoPng.length }],
      author: {
        id: 'user-custom',
        bot: false,
        username: 'raw_user',
        globalName: 'Global Name',
        avatar: 'abc',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-custom/abc.png?size=256',
      },
      member: { displayName: 'Server Nick ✨' },
    });
    await app.prefixCommandHandler.handle(msgCustom);
    const customFiles = msgCustom.getReplies()[0].payload.files;
    assert.equal(customFiles[0].name, IGF_ATTACHMENT_NAME);
    assert.equal(customFiles[0].attachment.readUInt32BE(16), IGF_SIZE);
    assert.equal(customFiles[0].attachment.readUInt32BE(20), IGF_SIZE);

    // 2. Reply to another message containing 1 WebP attachment + default Discord avatar
    const repliedMsg = createFakeMessage({
      content: 'here is a photo',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.webp', contentType: 'image/webp', size: 2048 }],
    });
    repliedMsg.id = 'ref-999';
    const msgReply = createFakeMessage({
      content: '!igf',
      attachments: [],
      reference: { messageId: 'ref-999' },
      referencedMessage: repliedMsg,
      author: {
        id: 'user-default',
        bot: false,
        username: 'default_user',
        globalName: null,
        avatar: null,
        displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
    });
    await app.prefixCommandHandler.handle(msgReply);
    const replyFiles = msgReply.getReplies()[0].payload.files;
    assert.equal(replyFiles[0].name, IGF_ATTACHMENT_NAME);
    assert.equal(replyFiles[0].attachment.readUInt32BE(16), IGF_SIZE);

    // 3. Error: no attachment and no reply (includes clear usage format guide)
    const msgEmpty = createFakeMessage({ content: '!igf', attachments: [] });
    await app.prefixCommandHandler.handle(msgEmpty);
    const emptyDesc = msgEmpty.getReplies()[0].payload.embeds[0].toJSON().description;
    assert.match(emptyDesc, /Kirim satu gambar/i);
    assert.match(emptyDesc, /Format Penggunaan/i);
    assert.match(emptyDesc, /caption opsional/i);

    // 3b. Custom caption passed via !igf <caption...>
    const msgWithCaption = createFakeMessage({
      content: '!igf santai sore hari 🌤️',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: photoPng.length }],
      author: {
        id: 'user-custom',
        bot: false,
        username: 'raw_user',
        globalName: 'Global Name',
        avatar: 'abc',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-custom/abc.png?size=256',
      },
    });
    await app.prefixCommandHandler.handle(msgWithCaption);
    const captionFiles = msgWithCaption.getReplies()[0].payload.files;
    assert.equal(captionFiles[0].name, IGF_ATTACHMENT_NAME);
    assert.equal(captionFiles[0].attachment.readUInt32BE(16), IGF_SIZE);

    // 4. Error: more than 1 attachment
    const msgMulti = createFakeMessage({
      content: '!igf',
      attachments: [
        { url: 'https://cdn.discordapp.com/a.png', contentType: 'image/png', size: 100 },
        { url: 'https://cdn.discordapp.com/b.png', contentType: 'image/png', size: 100 },
      ],
    });
    await app.prefixCommandHandler.handle(msgMulti);
    assert.match(msgMulti.getReplies()[0].payload.embeds[0].toJSON().description, /hanya satu gambar/i);

    // 5. Error: avatar fetch failure handled cleanly
    const msgAvatarFail = createFakeMessage({
      content: '!igf',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: photoPng.length }],
      author: {
        id: 'user-missing-avatar',
        bot: false,
        username: 'missing_av',
        globalName: 'Missing Avatar',
        avatar: 'missing',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/missing/missing.png?size=256',
      },
    });
    await app.prefixCommandHandler.handle(msgAvatarFail);
    assert.match(msgAvatarFail.getReplies()[0].payload.embeds[0].toJSON().description, /Gagal mengambil avatar Discord/i);

    // 6. Error: canvas renderer failure handled cleanly
    app.prefixCommandHandler.setContext({
      ...app.context,
      fetchFn: mockFetch,
      renderInstagramFrame: async () => {
        throw new Error('Gagal merender kartu Instagram frame.');
      },
    });
    const msgCanvasFail = createFakeMessage({
      content: '!igf',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: photoPng.length }],
      author: {
        id: 'user-custom',
        bot: false,
        username: 'raw_user',
        globalName: 'Global Name',
        avatar: 'abc',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-custom/abc.png?size=256',
      },
    });
    await app.prefixCommandHandler.handle(msgCanvasFail);
    assert.match(msgCanvasFail.getReplies()[0].payload.embeds[0].toJSON().description, /Gagal merender/i);

    app.shutdown();
  });
});
