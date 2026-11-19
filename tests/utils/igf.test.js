import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PermissionFlagsBits } from 'discord.js';
import {
  IGF_ATTACHMENT_NAME,
  IGF_MAX_IMAGE_BYTES,
  IGF_MAX_PHOTO_HEIGHT,
  IGF_MAX_PHOTO_WIDTH,
  computeContainRect,
  computeCoverCrop,
  computeIgfLayout,
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

  it('computes centered object-fit cover crop (for avatars) and contain rect (for photos) without distortion', () => {
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

    // object-fit: contain preserves exact aspect ratios
    assert.deepEqual(computeContainRect(800, 1000, 656, 820), {
      dx: 0,
      dy: 0,
      dw: 656,
      dh: 820,
    });
    assert.deepEqual(computeContainRect(1920, 1080, 860, 484), {
      dx: 0,
      dy: 0,
      dw: 860,
      dh: 484,
    });
    assert.deepEqual(computeContainRect(200, 1200, 440, 820), {
      dx: 152,
      dy: 0,
      dw: 137,
      dh: 820,
    });
  });

  it('adapts layout dynamically for 4:5 portrait, 1:1 square, and 16:9 landscape without outer padding', () => {
    const portraitLayout = computeIgfLayout({ srcWidth: 1080, srcHeight: 1350, captionLines: 0 });
    assert.equal(portraitLayout.photoBoxWidth, 656);
    assert.equal(portraitLayout.photoBoxHeight, 820);
    assert.ok(portraitLayout.cardWidth < portraitLayout.cardHeight, '4:5 portrait must stay portrait');
    assert.ok(portraitLayout.photoBoxWidth <= IGF_MAX_PHOTO_WIDTH);
    assert.ok(portraitLayout.photoBoxHeight <= IGF_MAX_PHOTO_HEIGHT);

    const squareLayout = computeIgfLayout({ srcWidth: 1080, srcHeight: 1080, captionLines: 0 });
    assert.equal(squareLayout.photoBoxWidth, squareLayout.photoBoxHeight, '1:1 photo box must stay square');
    assert.equal(squareLayout.photoBoxWidth, 820);

    const landscapeLayout = computeIgfLayout({ srcWidth: 1920, srcHeight: 1080, captionLines: 2 });
    assert.equal(landscapeLayout.photoBoxWidth, 860);
    assert.equal(landscapeLayout.photoBoxHeight, 484);
    assert.ok(landscapeLayout.cardWidth > landscapeLayout.cardHeight, '16:9 landscape must stay landscape');
  });

  it('renders tight-fitted dynamic PNGs preserving full photo without cropping or outer padding for 4:5, 1:1, 16:9, WebP, and Unicode names', async () => {
    const avatarPng = makeSolidImageBuffer(256, 256, '#10b981', 'image/png');

    // 1. Landscape 16:9 3-band photo -> ALL 3 bands (red, green, blue) preserved, output width > height
    const landscape = makeThreeBandImageBuffer(1280, 720, ['#ef4444', '#22c55e', '#3b82f6'], true);
    const landscapeOut = await renderInstagramFrame({
      photoBuffer: landscape,
      avatarBuffer: avatarPng,
      username: 'kyy',
    });
    assert.ok(landscapeOut.subarray(0, 8).equals(PNG_SIGNATURE));
    const landscapeW = landscapeOut.readUInt32BE(16);
    const landscapeH = landscapeOut.readUInt32BE(20);
    assert.ok(landscapeW > landscapeH, `Expected landscape output (${landscapeW}x${landscapeH})`);
    assert.equal(landscapeW, 900);

    // Outer rounded corner pixel (0, 0) is transparent, while card top edge (24, 2) is opaque white (zero outer padding)
    assert.deepEqual(await readPixel(landscapeOut, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(await readPixel(landscapeOut, landscapeW - 1, landscapeH - 1), [0, 0, 0, 0]);
    assert.deepEqual(await readPixel(landscapeOut, 24, 2), [255, 255, 255, 255]);

    const landscapeLayout = computeIgfLayout({ srcWidth: 1280, srcHeight: 720, captionLines: 0 });
    const photoMidY = landscapeLayout.photoY + Math.round(landscapeLayout.photoBoxHeight / 2);
    const leftBand = await readPixel(landscapeOut, landscapeLayout.photoX + 40, photoMidY);
    const centerBand = await readPixel(
      landscapeOut,
      landscapeLayout.photoX + Math.round(landscapeLayout.photoBoxWidth / 2),
      photoMidY,
    );
    const rightBand = await readPixel(
      landscapeOut,
      landscapeLayout.photoX + landscapeLayout.photoBoxWidth - 40,
      photoMidY,
    );
    assert.ok(leftBand[0] > leftBand[1] && leftBand[0] > leftBand[2], 'Expected red left band preserved');
    assert.ok(centerBand[1] > centerBand[0] && centerBand[1] > centerBand[2], 'Expected green center band preserved');
    assert.ok(rightBand[2] > rightBand[0] && rightBand[2] > rightBand[1], 'Expected blue right band preserved');

    // 2. Portrait 4:5 3-band vertical photo -> ALL 3 bands (red, yellow, blue) preserved, output width < height
    const portrait = makeThreeBandImageBuffer(800, 1000, ['#ef4444', '#eab308', '#3b82f6'], false);
    const portraitOut = await renderInstagramFrame({
      photoBuffer: portrait,
      avatarBuffer: avatarPng,
      username: 'VeryLongDiscordUsernameThatShouldTruncateCleanly1234567890',
    });
    const portraitW = portraitOut.readUInt32BE(16);
    const portraitH = portraitOut.readUInt32BE(20);
    assert.ok(portraitW < portraitH, `Expected portrait output (${portraitW}x${portraitH})`);
    assert.equal(portraitW, 696);

    const portraitLayout = computeIgfLayout({ srcWidth: 800, srcHeight: 1000, captionLines: 0 });
    const photoMidX = portraitLayout.photoX + Math.round(portraitLayout.photoBoxWidth / 2);
    const topBand = await readPixel(portraitOut, photoMidX, portraitLayout.photoY + 40);
    const midBand = await readPixel(
      portraitOut,
      photoMidX,
      portraitLayout.photoY + Math.round(portraitLayout.photoBoxHeight / 2),
    );
    const bottomBand = await readPixel(
      portraitOut,
      photoMidX,
      portraitLayout.photoY + portraitLayout.photoBoxHeight - 40,
    );
    assert.ok(topBand[0] > topBand[2] && topBand[1] < 100, 'Expected red top band preserved');
    assert.ok(midBand[0] > 200 && midBand[1] > 150 && midBand[2] < 50, 'Expected yellow middle band preserved');
    assert.ok(bottomBand[2] > bottomBand[0] && bottomBand[2] > bottomBand[1], 'Expected blue bottom band preserved');

    // 3. Square 1:1 + WebP photo + Unicode & emoji username + custom multi-line Unicode caption
    const webpSquare = makeSolidImageBuffer(600, 600, '#8b5cf6', 'image/webp');
    const webpOut = await renderInstagramFrame({
      photoBuffer: webpSquare,
      avatarBuffer: avatarPng,
      username: 'kỹy 山田太郎 ✨',
      caption: 'jalan sore menikmati senja di pinggir pantai bareng teman lama 🌅✨',
    });
    const webpW = webpOut.readUInt32BE(16);
    const webpH = webpOut.readUInt32BE(20);
    assert.equal(webpW, 860);
    assert.ok(webpH > webpW);
    const webpCenter = await readPixel(webpOut, Math.round(webpW / 2), 88 + 410);
    assert.ok(webpCenter[2] > 200 && webpCenter[0] > 100, 'Expected purple WebP pixel rendered in square photo box');
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
    assert.ok(
      noCaptionUndefined.readUInt32BE(20) < withExplicitCaption.readUInt32BE(20),
      'Card without caption should shrink tightly with no wasted bottom whitespace',
    );

    // Ensure no blue hashtag (#2B7DE9) pixels are drawn below the action bar when caption is omitted.
    const img = await loadImage(noCaptionUndefined);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const footerBelowActionBarY = 88 + 820 + 60;
    const region = ctx.getImageData(20, footerBelowActionBarY, img.width - 40, img.height - footerBelowActionBarY).data;
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

  it('executes !igf end-to-end with portrait (4:5), square (1:1), landscape (16:9), reply attachment, and error handling', async () => {
    const portraitPng = makeSolidImageBuffer(800, 1000, '#0284c7', 'image/png');
    const landscapePng = makeSolidImageBuffer(1280, 720, '#ec4899', 'image/png');
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
      if (url.includes('landscape.png')) {
        return { ok: true, headers: new Headers(), arrayBuffer: async () => landscapePng };
      }
      if (url.includes('photo.png')) {
        return { ok: true, headers: new Headers(), arrayBuffer: async () => portraitPng };
      }
      return { ok: false, status: 404 };
    };

    const app = await createBotApp({ cooldowns: new CooldownManager(0) });
    app.prefixCommandHandler.setContext({ ...app.context, fetchFn: mockFetch });

    // 1. Direct portrait (4:5) attachment with custom avatar & server nickname
    const msgCustom = createFakeMessage({
      content: '!igf',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: portraitPng.length }],
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
    const portraitOutW = customFiles[0].attachment.readUInt32BE(16);
    const portraitOutH = customFiles[0].attachment.readUInt32BE(20);
    assert.ok(portraitOutW < portraitOutH, `Expected portrait output (${portraitOutW}x${portraitOutH})`);

    // 1b. Direct landscape (16:9) attachment
    const msgLandscape = createFakeMessage({
      content: '!igf',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/landscape.png', contentType: 'image/png', size: landscapePng.length }],
      author: {
        id: 'user-custom',
        bot: false,
        username: 'raw_user',
        globalName: 'Global Name',
        avatar: 'abc',
        displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-custom/abc.png?size=256',
      },
    });
    await app.prefixCommandHandler.handle(msgLandscape);
    const landscapeFiles = msgLandscape.getReplies()[0].payload.files;
    assert.equal(landscapeFiles[0].name, IGF_ATTACHMENT_NAME);
    const landscapeOutW = landscapeFiles[0].attachment.readUInt32BE(16);
    const landscapeOutH = landscapeFiles[0].attachment.readUInt32BE(20);
    assert.ok(landscapeOutW > landscapeOutH, `Expected landscape output (${landscapeOutW}x${landscapeOutH})`);

    // 2. Reply to another message containing 1 square WebP attachment + default Discord avatar
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
    assert.equal(replyFiles[0].attachment.readUInt32BE(16), 860);

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
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: portraitPng.length }],
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
    assert.equal(captionFiles[0].attachment.readUInt32BE(16), portraitOutW);
    assert.ok(captionFiles[0].attachment.readUInt32BE(20) > portraitOutH);

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
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: portraitPng.length }],
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
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/photo.png', contentType: 'image/png', size: portraitPng.length }],
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
