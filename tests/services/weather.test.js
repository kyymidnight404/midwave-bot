import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createBotApp } from '../../src/index.js';
import {
  buildWeatherEmbed,
  clearWeatherCaches,
  fetchBmkgWeather,
  resolveBmkgAdm4,
  WeatherError,
} from '../../src/services/weatherService.js';
import { CooldownManager } from '../../src/utils/cooldown.js';

function createFakeChannel(id = 'ch-weather-1') {
  return {
    id,
    isTextBased: () => true,
    async send(payload) {
      return { id: 'msg-send-1', channelId: id, payload };
    },
  };
}

function createFakeClient(channel) {
  return {
    user: { id: 'bot-1', username: 'Midwave' },
    channels: {
      cache: new Map([[channel.id, channel]]),
      async fetch(id) {
        return id === channel.id ? channel : null;
      },
    },
    on() {},
    once() {},
    destroy() {},
  };
}

function createPrefixMessage({ content, author, channel, client }) {
  const replies = [];
  let seq = 1;
  return {
    id: 'msg-user-1',
    content,
    author,
    guildId: 'guild-weather-1',
    channelId: channel.id,
    channel,
    client,
    mentions: {
      users: { get: () => undefined, has: () => false, first: () => undefined },
    },
    getReplies: () => replies,
    async reply(payload) {
      const msg = {
        id: `reply-${seq++}`,
        channelId: channel.id,
        payload,
        edits: [],
        async edit(next) {
          this.payload = { ...this.payload, ...next };
          this.edits.push(next);
          return this;
        },
      };
      replies.push(msg);
      return msg;
    },
  };
}

function createMockBmkgFetch({ adm4 = '31.71.03.1001', failBmkg = false } = {}) {
  return async (url) => {
    if (url.includes('wilayah.id/api/districts/')) {
      return {
        ok: true,
        async json() {
          return {
            data: [
              { code: '31.71.01', name: 'Gambir' },
              { code: '31.71.03', name: 'Kemayoran' },
            ],
          };
        },
      };
    }
    if (url.includes('wilayah.id/api/villages/31.71.03')) {
      return {
        ok: true,
        async json() {
          return {
            data: [
              { code: '31.71.03.1001', name: 'Kemayoran' },
              { code: '31.71.03.1002', name: 'Kebon Kosong' },
            ],
          };
        },
      };
    }
    if (url.includes('wilayah.id/api/villages/')) {
      return {
        ok: true,
        async json() {
          return { data: [{ code: adm4, name: 'Gambir' }] };
        },
      };
    }
    if (url.includes('nominatim.openstreetmap.org')) {
      return {
        ok: true,
        async json() {
          return [];
        },
      };
    }
    if (url.includes('api.bmkg.go.id/publik/prakiraan-cuaca')) {
      if (failBmkg) {
        return { ok: false, status: 503, async json() { return {}; } };
      }
      return {
        ok: true,
        async json() {
          return {
            lokasi: {
              adm4,
              desa: 'Kemayoran',
              kecamatan: 'Kemayoran',
              kotkab: 'Kota Adm. Jakarta Pusat',
              provinsi: 'DKI Jakarta',
            },
            data: [
              {
                cuaca: [
                  [
                    {
                      datetime: '2026-11-17T03:00:00Z',
                      local_datetime: '2026-11-17 10:00:00',
                      t: 31,
                      hu: 70,
                      weather_desc: 'Cerah Berawan',
                      ws: 12,
                      wd: 'NW',
                      tcc: 45,
                    },
                    {
                      datetime: '2026-11-17T06:00:00Z',
                      local_datetime: '2026-11-17 13:00:00',
                      t: 33,
                      hu: 65,
                      weather_desc: 'Hujan Ringan',
                      ws: 15,
                      wd: 'W',
                      tcc: 80,
                    },
                  ],
                ],
              },
            ],
          };
        },
      };
    }
    throw new Error(`Unexpected URL in mock: ${url}`);
  };
}

describe('BMKG Weather Service & Command (!weather / /weather)', () => {
  beforeEach(() => {
    clearWeatherCaches();
  });

  it('resolves ADM4 codes directly, city/kecamatan queries, and rejects empty or unknown locations', async () => {
    const mockFetch = createMockBmkgFetch();

    assert.equal(await resolveBmkgAdm4('31.71.03.1001', { fetchFn: mockFetch }), '31.71.03.1001');
    assert.equal(await resolveBmkgAdm4('Kemayoran, Jakarta', { fetchFn: mockFetch }), '31.71.03.1001');
    assert.equal(await resolveBmkgAdm4('Jakarta', { fetchFn: mockFetch }), '31.71.03.1001');

    await assert.rejects(() => resolveBmkgAdm4('   ', { fetchFn: mockFetch }), (err) => err instanceof WeatherError);
    await assert.rejects(() => resolveBmkgAdm4('Atlantis', { fetchFn: mockFetch }), (err) => err instanceof WeatherError);
  });

  it('builds a footer-free weather embed with weather.png thumbnail and BMKG attribution', async () => {
    const mockFetch = createMockBmkgFetch();
    const data = await fetchBmkgWeather('Kemayoran, Jakarta', {
      fetchFn: mockFetch,
      nowMs: Date.parse('2026-11-17T03:15:00Z'),
    });

    const embedJson = buildWeatherEmbed(data, { includeThumbnail: true }).toJSON();
    assert.equal(embedJson.footer, undefined);
    assert.equal(embedJson.timestamp, undefined);
    assert.equal(embedJson.thumbnail?.url, 'attachment://weather.png');
    assert.match(embedJson.title, /Jakarta Pusat/);
    assert.match(embedJson.description, /Cerah Berawan/);
    assert.match(embedJson.description, /BMKG/);
    assert.ok(embedJson.fields.some((f) => f.name.includes('Suhu') && f.value.includes('31°C')));
    assert.ok(embedJson.fields.some((f) => f.name.includes('Prakiraan Berikutnya') && f.value.includes('13:00')));
  });

  it('executes !weather <lokasi> end-to-end with weather.png attachment and error handling', async () => {
    const channel = createFakeChannel();
    const client = createFakeClient(channel);
    const app = await createBotApp({
      client,
      prisma: {},
      cooldowns: new CooldownManager(0),
    });
    app.context.fetchFn = createMockBmkgFetch();
    app.context.nowMs = Date.parse('2026-11-17T03:15:00Z');

    const user = { id: '100000000000000001', username: 'kyy', bot: false };
    try {
      const msg = createPrefixMessage({
        content: '!weather Kemayoran, Jakarta',
        author: user,
        channel,
        client,
      });
      await app.prefixCommandHandler.handle(msg);

      const replies = msg.getReplies();
      assert.equal(replies.length, 1);
      const finalPayload = replies[0].payload;
      const embedJson = finalPayload.embeds[0].toJSON();
      assert.equal(embedJson.thumbnail?.url, 'attachment://weather.png');
      assert.equal(embedJson.footer, undefined);
      assert.ok(finalPayload.files.some((f) => f.name === 'weather.png'));
    } finally {
      app.shutdown();
    }
  });
});
