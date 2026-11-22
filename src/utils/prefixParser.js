import {
  DIFFICULTIES,
  GAME_TYPES,
  QUIZ_CATEGORIES,
} from './constants.js';
import { SOLO_SOCIAL_COMMANDS, TARGETED_SOCIAL_COMMANDS } from '../services/otakuGifsService.js';

const COMMAND_ALIASES = Object.freeze({
  ai: 'ai',
  anime: 'anime',
  lyrics: 'lyrics',
  lyric: 'lyrics',
  lirik: 'lyrics',
  menu: 'menu',
  donate: 'donate',
  ping: 'ping',
  brat: 'brat',
  download: 'download',
  dl: 'download',
  pin: 'pin',
  igf: 'igf',
  qc: 'qc',
  say: 'say',
  feedback: 'feedback',
  math: 'math',
  hug: 'hug',
  pat: 'pat',
  slap: 'slap',
  bonk: 'bonk',
  kick: 'kick',
  poke: 'poke',
  yeet: 'yeet',
  highfive: 'highfive',
  wave: 'wave',
  laugh: 'laugh',
  cry: 'cry',
  rps: 'rps',
  coinflip: 'coinflip',
  cf: 'coinflip',
  tictactoe: 'tictactoe',
  ttt: 'tictactoe',
  quiz: 'quiz',
  knowledge: 'knowledge',
  weather: 'weather',
  cuaca: 'weather',
});

const RPS_CHOICE_MAP = Object.freeze({
  rock: 'rock',
  batu: 'rock',
  paper: 'paper',
  kertas: 'paper',
  scissors: 'scissors',
  scissor: 'scissors',
  gunting: 'scissors',
});

const COIN_CHOICE_MAP = Object.freeze({
  heads: 'heads',
  head: 'heads',
  tails: 'tails',
  tail: 'tails',
});

const QUIZ_CATEGORY_SET = new Set(QUIZ_CATEGORIES);
const DIFFICULTY_SET = new Set(DIFFICULTIES);
const TARGETED_SOCIAL_SET = new Set(TARGETED_SOCIAL_COMMANDS);
const SOLO_SOCIAL_SET = new Set(SOLO_SOCIAL_COMMANDS);

/**
 * Resolves the configured command prefix, defaulting to `!`.
 * @param {string | undefined} rawPrefix
 * @returns {string}
 */
export function resolvePrefix(rawPrefix) {
  if (typeof rawPrefix !== 'string') {
    return '!';
  }
  const trimmed = rawPrefix.trim();
  return trimmed.length > 0 ? trimmed : '!';
}

/**
 * Extracts a Discord user ID from a mention (`<@123>`, `<@!123>`) or numeric snowflake.
 * @param {string | undefined} token
 * @returns {string | null}
 */
export function extractMentionOrId(token) {
  if (typeof token !== 'string') {
    return null;
  }
  const mentionMatch = token.match(/^<@!?(\d{17,22})>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  if (/^\d{17,22}$/.test(token)) {
    return token;
  }
  return null;
}

/**
 * Parses a prefix message into a Midwave command invocation.
 * Returns `null` when the message does not start with `prefix` or does not match a known command.
 *
 * @param {string} content
 * @param {{ prefix?: string, userId?: string | null, gameManager?: object | null }} [context]
 * @returns {{
 *   commandName: string,
 *   subcommand: string | null,
 *   options: Record<string, any>,
 *   error?: string,
 * } | null}
 */
export function parsePrefixInvocation(content, { prefix = '!', userId = null, gameManager = null } = {}) {
  if (typeof content !== 'string' || !content.startsWith(prefix)) {
    return null;
  }

  const afterPrefix = content.slice(prefix.length);
  if (!/^[a-z0-9]/i.test(afterPrefix)) {
    return null;
  }

  const tokenMatch = afterPrefix.match(/^([a-z0-9]+)(?:\s+([\s\S]*))?$/i);
  if (!tokenMatch) {
    return null;
  }

  const rawCommand = tokenMatch[1].toLowerCase();
  const commandName = COMMAND_ALIASES[rawCommand];
  if (!commandName) {
    return null;
  }

  const rawRest = (tokenMatch[2] ?? '').trim();
  const args = rawRest ? rawRest.split(/\s+/) : [];
  const firstLower = args[0]?.toLowerCase() ?? '';

  if (commandName === 'knowledge') {
    const sub = firstLower;
    const bodyAfterSub = rawRest.slice(args[0]?.length ?? 0).trim();
    const usage =
      `Format \`${prefix}knowledge\`: \`categories\`, \`list [kategori]\`, \`search [category:<kat>] <kata kunci>\`, ` +
      `\`add <id> | <kategori> | <judul> | <isi> [| <tags>] [| <status>]\`, ` +
      `\`update <id> | title=<...> | content=<...>\`, \`remove <id>\`, \`reload\`.`;

    if (!sub) {
      return { commandName: 'knowledge', subcommand: null, options: {}, error: usage };
    }
    if (sub === 'categories' || sub === 'reload') {
      return { commandName: 'knowledge', subcommand: sub, options: {} };
    }
    if (sub === 'list') {
      const category = args[1]?.trim() || null;
      return { commandName: 'knowledge', subcommand: 'list', options: category ? { category } : {} };
    }
    if (sub === 'search') {
      let category = null;
      const queryTokens = [];
      for (const token of args.slice(1)) {
        if (/^category:/i.test(token)) {
          category = token.slice('category:'.length).trim() || null;
        } else {
          queryTokens.push(token);
        }
      }
      return {
        commandName: 'knowledge',
        subcommand: 'search',
        options: { query: queryTokens.join(' '), ...(category ? { category } : {}) },
      };
    }
    if (sub === 'remove' || sub === 'delete') {
      const id = args[1]?.trim() ?? '';
      if (!id || args.length > 2) {
        return {
          commandName: 'knowledge',
          subcommand: sub,
          options: {},
          error: `Gunakan \`${prefix}knowledge ${sub} <id>\`.`,
        };
      }
      return { commandName: 'knowledge', subcommand: sub, options: { id } };
    }
    if (sub === 'add') {
      const parts = bodyAfterSub.split('|').map((s) => s.trim());
      if (parts.length < 4 || !parts[0] || !parts[1] || !parts[2] || !parts[3]) {
        return {
          commandName: 'knowledge',
          subcommand: 'add',
          options: {},
          error: `Gunakan \`${prefix}knowledge add <id> | <kategori> | <judul> | <isi> [| <tags>] [| <status>]\`.`,
        };
      }
      const [id, category, title, itemContent, tags, status] = parts;
      return {
        commandName: 'knowledge',
        subcommand: 'add',
        options: {
          id,
          category,
          title,
          content: itemContent,
          ...(tags ? { tags } : {}),
          ...(status ? { status } : {}),
        },
      };
    }
    if (sub === 'update') {
      const parts = bodyAfterSub.split('|').map((s) => s.trim());
      const id = parts[0] || '';
      if (!id || parts.length < 2) {
        return {
          commandName: 'knowledge',
          subcommand: 'update',
          options: {},
          error: `Gunakan \`${prefix}knowledge update <id> | title=<...> | content=<...> | category=<...> | tags=<...> | status=<...>\`.`,
        };
      }
      const restParts = parts.slice(1);
      const options = { id };
      const hasKeyValue = restParts.some((p) => /^(title|content|category|tags|status)=/i.test(p));
      if (hasKeyValue) {
        for (const p of restParts) {
          const eqIdx = p.indexOf('=');
          if (eqIdx > 0) {
            const k = p.slice(0, eqIdx).trim().toLowerCase();
            const v = p.slice(eqIdx + 1).trim();
            if (['title', 'content', 'category', 'tags', 'status'].includes(k) && v) {
              options[k] = v;
            }
          }
        }
      } else {
        const keys = ['title', 'content', 'category', 'tags', 'status'];
        restParts.forEach((val, idx) => {
          if (idx < keys.length && val && val !== '-') {
            options[keys[idx]] = val;
          }
        });
      }
      return { commandName: 'knowledge', subcommand: 'update', options };
    }

    return { commandName: 'knowledge', subcommand: null, options: {}, error: usage };
  }

  if (commandName === 'quiz') {
    let category = 'all';
    let difficulty = 'all';

    for (const token of args) {
      const lower = token.toLowerCase();
      if (lower === 'all') continue;
      if (QUIZ_CATEGORY_SET.has(lower)) {
        category = lower;
      } else if (DIFFICULTY_SET.has(lower)) {
        difficulty = lower;
      } else {
        return {
          commandName: 'quiz',
          subcommand: null,
          options: {},
          error: `Argumen \`${token}\` tidak dikenali. Contoh: \`${prefix}quiz\`, \`${prefix}quiz science\`, atau \`${prefix}quiz science hard\`.`,
        };
      }
    }

    return { commandName: 'quiz', subcommand: null, options: { category, difficulty } };
  }

  if (commandName === 'donate' || commandName === 'menu' || commandName === 'ping') {
    return { commandName, subcommand: null, options: {} };
  }

  if (commandName === 'feedback') {
    return { commandName, subcommand: null, options: {} };
  }

  if (commandName === 'weather') {
    if (!rawRest) {
      return {
        commandName: 'weather',
        subcommand: null,
        options: {},
        error: `Masukkan nama lokasi di Indonesia. Contoh: \`${prefix}weather Jakarta\` atau \`${prefix}weather Kemayoran, Jakarta\`.`,
      };
    }
    return { commandName: 'weather', subcommand: null, options: { location: rawRest } };
  }

  if (commandName === 'anime') {
    if (!rawRest) {
      return {
        commandName: 'anime',
        subcommand: null,
        options: {},
        error: `Judul anime wajib diisi. Contoh: \`${prefix}anime Sousou no Frieren\` atau \`${prefix}anime One Piece\`.`,
      };
    }
    return { commandName: 'anime', subcommand: null, options: { query: rawRest } };
  }

  if (commandName === 'igf') {
    return {
      commandName,
      subcommand: null,
      options: rawRest ? { caption: rawRest } : {},
    };
  }

  if (commandName === 'say') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Masukkan pesan yang ingin diulang. Contoh: \`${prefix}say Halo semuanya!\`.`,
      };
    }
    return { commandName, subcommand: null, options: { text: rawRest } };
  }

  if (commandName === 'qc') {
    return {
      commandName,
      subcommand: null,
      options: rawRest ? { text: rawRest } : {},
    };
  }

  if (commandName === 'ai') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Pertanyaan wajib diisi. Contoh: \`${prefix}ai Apa itu JavaScript?\`.`,
      };
    }
    return { commandName, subcommand: null, options: { question: rawRest } };
  }

  if (commandName === 'lyrics') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Judul lagu wajib diisi. Contoh: \`${prefix}lyrics APT\` atau \`${prefix}lyrics Love | wave to earth\`.`,
      };
    }

    const pipeIndex = rawRest.indexOf('|');
    if (pipeIndex !== -1) {
      const queryPart = rawRest.slice(0, pipeIndex).trim();
      const artistPart = rawRest.slice(pipeIndex + 1).trim();
      if (!queryPart) {
        return {
          commandName,
          subcommand: null,
          options: {},
          error: `Judul lagu wajib diisi sebelum \`|\`. Contoh: \`${prefix}lyrics Love | wave to earth\`.`,
        };
      }
      return {
        commandName,
        subcommand: null,
        options: artistPart ? { query: queryPart, artist: artistPart } : { query: queryPart },
      };
    }

    return { commandName, subcommand: null, options: { query: rawRest } };
  }

  if (commandName === 'brat') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Teks wajib diisi. Contoh: \`${prefix}brat midnight ocean\`.`,
      };
    }
    return { commandName, subcommand: null, options: { text: rawRest } };
  }

  if (commandName === 'download') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Tautan \`url\` wajib diisi. Contoh: \`${prefix}download https://www.youtube.com/watch?v=...\` atau \`${prefix}download https://vt.tiktok.com/...\`.`,
      };
    }

    return {
      commandName,
      subcommand: null,
      options: { url: rawRest },
    };
  }

  if (commandName === 'pin') {
    if (!rawRest) {
      return {
        commandName: 'pin',
        subcommand: null,
        options: {},
        error: `Kata kunci pencarian Pinterest wajib diisi. Contoh: \`${prefix}pin aesthetic wallpaper\`.`,
      };
    }

    return {
      commandName: 'pin',
      subcommand: null,
      options: { query: rawRest },
    };
  }

  if (commandName === 'math') {
    if (!rawRest) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Ekspresi matematika wajib diisi. Contoh: \`${prefix}math 2 + 2\`.`,
      };
    }
    return { commandName, subcommand: null, options: { expression: rawRest } };
  }

  if (SOLO_SOCIAL_SET.has(commandName)) {
    return { commandName, subcommand: null, options: {} };
  }

  if (TARGETED_SOCIAL_SET.has(commandName)) {
    if (!args[0]) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Mention pengguna target terlebih dahulu. Contoh: \`${prefix}${commandName} @user\`.`,
      };
    }
    const targetId = extractMentionOrId(args[0]);
    if (!targetId) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Target harus berupa mention atau ID pengguna Discord yang valid. Contoh: \`${prefix}${commandName} @user\`.`,
      };
    }
    return { commandName, subcommand: null, options: { userId: targetId } };
  }

  if (commandName === GAME_TYPES.RPS) {
    if (args.length === 0) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Gunakan \`${prefix}rps <rock|paper|scissors>\` atau \`${prefix}rps @teman\`.`,
      };
    }

    if (firstLower === 'solo' || firstLower === 'choose') {
      const choice = RPS_CHOICE_MAP[args[1]?.toLowerCase() ?? ''];
      if (!choice || args.length > 2) {
        return {
          commandName,
          subcommand: firstLower,
          options: {},
          error: `Pilihan tidak valid. Gunakan \`rock\`, \`paper\`, atau \`scissors\`. Contoh: \`${prefix}rps ${firstLower} rock\`.`,
        };
      }
      return { commandName, subcommand: firstLower, options: { choice } };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId || args.length > 2) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}rps challenge @teman\`.`,
        };
      }
      return { commandName, subcommand: 'challenge', options: { opponentId } };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId && args.length === 1) {
      return { commandName, subcommand: 'challenge', options: { opponentId: directMentionId } };
    }

    const directChoice = RPS_CHOICE_MAP[firstLower];
    if (directChoice && args.length === 1) {
      const status = userId && gameManager?.getStatus ? gameManager.getStatus(userId) : null;
      const isActiveMultiplayerRps =
        status?.type === 'session' &&
        status.session.gameType === GAME_TYPES.RPS &&
        status.session.mode === 'multiplayer';
      return {
        commandName,
        subcommand: isActiveMultiplayerRps ? 'choose' : 'solo',
        options: { choice: directChoice },
      };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Format \`${prefix}rps\` tidak valid. Gunakan \`${prefix}rps <rock|paper|scissors>\` atau \`${prefix}rps @teman\`.`,
    };
  }

  if (commandName === GAME_TYPES.COINFLIP) {
    if (args.length === 0) {
      return {
        commandName,
        subcommand: 'solo',
        options: {},
      };
    }

    if (firstLower === 'solo' || firstLower === 'choose') {
      const choice = COIN_CHOICE_MAP[args[1]?.toLowerCase() ?? ''];
      if (!choice || args.length > 2) {
        return {
          commandName,
          subcommand: firstLower,
          options: {},
          error: `Pilihan tidak valid. Gunakan \`heads\` atau \`tails\`. Contoh: \`${prefix}coinflip ${firstLower} heads\`.`,
        };
      }
      return { commandName, subcommand: firstLower, options: { choice } };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId || args.length > 2) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}coinflip challenge @teman\`.`,
        };
      }
      return { commandName, subcommand: 'challenge', options: { opponentId } };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId && args.length === 1) {
      return { commandName, subcommand: 'challenge', options: { opponentId: directMentionId } };
    }

    const directChoice = COIN_CHOICE_MAP[firstLower];
    if (directChoice && args.length === 1) {
      const status = userId && gameManager?.getStatus ? gameManager.getStatus(userId) : null;
      const isActiveMultiplayerCf =
        status?.type === 'session' &&
        status.session.gameType === GAME_TYPES.COINFLIP &&
        status.session.mode === 'multiplayer';
      return {
        commandName,
        subcommand: isActiveMultiplayerCf ? 'choose' : 'solo',
        options: { choice: directChoice },
      };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Format \`${prefix}coinflip\` tidak valid. Gunakan \`${prefix}coinflip <heads|tails>\` atau \`${prefix}coinflip @teman\`.`,
    };
  }

  if (commandName === GAME_TYPES.TICTACTOE) {
    if (args.length === 0) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Tic Tac Toe hanya bisa dimainkan bersama teman (bukan bot). Mention lawanmu, contoh: \`${prefix}ttt @teman\`.`,
      };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId || args.length > 2) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}tictactoe challenge @teman\`.`,
        };
      }
      return { commandName, subcommand: 'challenge', options: { opponentId } };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId && args.length === 1) {
      return { commandName, subcommand: 'challenge', options: { opponentId: directMentionId } };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Tic Tac Toe hanya bisa dimainkan bersama teman (bukan bot). Gunakan \`${prefix}ttt @teman\`.`,
    };
  }

  return null;
}
