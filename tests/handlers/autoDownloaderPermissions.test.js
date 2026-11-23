import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutoDownloaderHandler } from '../../src/handlers/AutoDownloaderHandler.js';

function createMessage({ me = { id: 'bot-1' }, permissionsFor } = {}) {
  return {
    author: { id: 'user-1', bot: false },
    content: 'https://www.instagram.com/p/ABC123/',
    guild: { members: { me } },
    channel: {
      permissionsFor,
      async sendTyping() {},
    },
  };
}

describe('AutoDownloaderHandler guild permission checks', () => {
  it('does not call the downloader when the bot member is unavailable', async () => {
    let downloadCalls = 0;
    const handler = new AutoDownloaderHandler({
      cooldowns: null,
      getConfig: () => ({ configured: true }),
      downloadFn: async () => {
        downloadCalls += 1;
        return { mode: 'attachments', items: [] };
      },
    });

    const handled = await handler.handle(createMessage({ me: null, permissionsFor: () => null }));
    assert.equal(handled, false);
    assert.equal(downloadCalls, 0);
  });

  it('fails closed when channel permissions cannot be resolved', async () => {
    let downloadCalls = 0;
    const handler = new AutoDownloaderHandler({
      cooldowns: null,
      getConfig: () => ({ configured: true }),
      downloadFn: async () => {
        downloadCalls += 1;
        return { mode: 'attachments', items: [] };
      },
    });

    const handled = await handler.handle(createMessage({
      permissionsFor: () => {
        throw new Error('permissions unavailable');
      },
    }));
    assert.equal(handled, false);
    assert.equal(downloadCalls, 0);
  });

  it('fails closed when permissionsFor is unavailable in a guild channel', async () => {
    let downloadCalls = 0;
    const handler = new AutoDownloaderHandler({
      cooldowns: null,
      getConfig: () => ({ configured: true }),
      downloadFn: async () => {
        downloadCalls += 1;
        return { mode: 'attachments', items: [] };
      },
    });

    const handled = await handler.handle(createMessage({ permissionsFor: undefined }));
    assert.equal(handled, false);
    assert.equal(downloadCalls, 0);
  });
});
