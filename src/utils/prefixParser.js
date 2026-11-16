import {
  DIFFICULTIES,
  DICE_CONFIG,
  GAME_TYPES,
  QUIZ_CATEGORIES,
  TTT_POSITIONS,
} from './constants.js';
import { SOLO_SOCIAL_COMMANDS, TARGETED_SOCIAL_COMMANDS } from '../services/otakuGifsService.js';

const COMMAND_ALIASES = Object.freeze({
  ai: 'ai',
  lyrics: 'lyrics',
  lyric: 'lyrics',
  lirik: 'lyrics',
  games: 'games',
  menu: 'menu',
  game: 'game',
  invite: 'invite',
  brat: 'brat',
  download: 'download',
  dl: 'download',
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
  guess: 'guess',
  ng: 'guess',
  rps: 'rps',
  coinflip: 'coinflip',
  cf: 'coinflip',
  dice: 'dice',
  tictactoe: 'tictactoe',
  ttt: 'tictactoe',
  connect4: 'connect4',
  c4: 'connect4',
  quiz: 'quiz',
  knowledge: 'knowledge',
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
const TTT_POSITION_SET = new Set(TTT_POSITIONS);
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
 * Parses `NdS` dice notation (for example `2d6`).
 * @param {string | undefined} token
 * @returns {{ count: number, sides: number } | null}
 */
export function parseDiceNotation(token) {
  if (typeof token !== 'string') {
    return null;
  }
  const match = token.match(/^(\d+)d(\d+)$/i);
  if (!match) {
    return null;
  }
  return {
    count: Number.parseInt(match[1], 10),
    sides: Number.parseInt(match[2], 10),
  };
}

/**
 * Parses a strict non-negative/signed integer string.
 * @param {string | undefined} token
 * @returns {number | null}
 */
function parseStrictInteger(token) {
  if (typeof token !== 'string' || !/^-?\d+$/.test(token)) {
    return null;
  }
  const parsed = Number.parseInt(token, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseDifficulty(token) {
  if (typeof token !== 'string') return null;
  const lower = token.toLowerCase();
  return DIFFICULTY_SET.has(lower) ? lower : null;
}

function parseDiceArgs(args, prefix) {
  if (args.length === 0) {
    return {
      count: DICE_CONFIG.DEFAULT_COUNT,
      sides: DICE_CONFIG.DEFAULT_SIDES,
    };
  }

  let count = DICE_CONFIG.DEFAULT_COUNT;
  let sides = DICE_CONFIG.DEFAULT_SIDES;

  const notation = parseDiceNotation(args[0]);
  if (notation) {
    if (args.length > 1) {
      return { error: `Argumen berlebih setelah \`${args[0]}\`. Contoh: \`${prefix}dice 2d6\`.` };
    }
    count = notation.count;
    sides = notation.sides;
  } else {
    const parsedCount = parseStrictInteger(args[0]);
    if (parsedCount === null) {
      return {
        error: `Format dadu tidak valid. Contoh: \`${prefix}dice\`, \`${prefix}dice 2d6\`, atau \`${prefix}dice 2 20\`.`,
      };
    }
    count = parsedCount;

    if (args.length >= 2) {
      const parsedSides = parseStrictInteger(args[1]);
      if (parsedSides === null) {
        return { error: `Jumlah sisi dadu harus berupa angka (${DICE_CONFIG.MIN_SIDES}–${DICE_CONFIG.MAX_SIDES}).` };
      }
      sides = parsedSides;
    }

    if (args.length > 2) {
      return { error: `Terlalu banyak argumen. Contoh: \`${prefix}dice 2 6\`.` };
    }
  }

  if (count < DICE_CONFIG.MIN_COUNT || count > DICE_CONFIG.MAX_COUNT) {
    return {
      error: `Jumlah dadu harus antara ${DICE_CONFIG.MIN_COUNT} sampai ${DICE_CONFIG.MAX_COUNT}.`,
    };
  }
  if (sides < DICE_CONFIG.MIN_SIDES || sides > DICE_CONFIG.MAX_SIDES) {
    return {
      error: `Jumlah sisi dadu harus antara ${DICE_CONFIG.MIN_SIDES} sampai ${DICE_CONFIG.MAX_SIDES}.`,
    };
  }

  return { count, sides };
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
      const [id, category, title, content, tags, status] = parts;
      return {
        commandName: 'knowledge',
        subcommand: 'add',
        options: {
          id,
          category,
          title,
          content,
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

  if (commandName === 'games' || commandName === 'menu') {
    return { commandName, subcommand: null, options: {} };
  }

  if (commandName === 'feedback') {
    return { commandName, subcommand: null, options: {} };
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
        error: `Tautan \`url\` wajib diisi. Contoh: \`${prefix}download https://www.instagram.com/reel/...\`.`,
      };
    }
    return { commandName, subcommand: null, options: { url: rawRest } };
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

  if (commandName === 'game') {
    if (!firstLower || firstLower === 'status') {
      return { commandName, subcommand: 'status', options: {} };
    }
    if (firstLower === 'cancel') {
      return { commandName, subcommand: 'cancel', options: {} };
    }
    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Gunakan \`${prefix}game status\` atau \`${prefix}game cancel\`.`,
    };
  }

  if (commandName === 'invite') {
    if (firstLower === 'accept' || firstLower === 'acc' || firstLower === 'yes') {
      return { commandName, subcommand: 'accept', options: {} };
    }
    if (firstLower === 'decline' || firstLower === 'dec' || firstLower === 'no') {
      return { commandName, subcommand: 'decline', options: {} };
    }
    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Gunakan \`${prefix}invite accept\` atau \`${prefix}invite decline\`.`,
    };
  }

  if (commandName === GAME_TYPES.GUESS) {
    if (args.length === 0) {
      return { commandName, subcommand: 'solo', options: { difficulty: 'normal' } };
    }

    if (firstLower === 'solo') {
      const diff = args[1] ? parseDifficulty(args[1]) : 'normal';
      if (!diff || args.length > 2) {
        return {
          commandName,
          subcommand: 'solo',
          options: {},
          error: `Gunakan \`${prefix}guess solo [easy|normal|hard]\`.`,
        };
      }
      return { commandName, subcommand: 'solo', options: { difficulty: diff } };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}guess challenge @teman normal\`.`,
        };
      }
      const diff = args[2] ? parseDifficulty(args[2]) : 'normal';
      if (!diff || args.length > 3) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Tingkat kesulitan tidak valid. Gunakan \`easy\`, \`normal\`, atau \`hard\`.`,
        };
      }
      return {
        commandName,
        subcommand: 'challenge',
        options: { opponentId, difficulty: diff },
      };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId) {
      const diff = args[1] ? parseDifficulty(args[1]) : 'normal';
      if (!diff || args.length > 2) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Gunakan \`${prefix}guess @teman [easy|normal|hard]\`.`,
        };
      }
      return {
        commandName,
        subcommand: 'challenge',
        options: { opponentId: directMentionId, difficulty: diff },
      };
    }

    if (firstLower === 'play') {
      const number = parseStrictInteger(args[1]);
      if (number === null || number < 1 || number > 200 || args.length > 2) {
        return {
          commandName,
          subcommand: 'play',
          options: {},
          error: `Masukkan angka tebakan antara 1–200. Contoh: \`${prefix}guess play 42\`.`,
        };
      }
      return { commandName, subcommand: 'play', options: { number } };
    }

    const directDiff = parseDifficulty(firstLower);
    if (directDiff && args.length === 1) {
      return { commandName, subcommand: 'solo', options: { difficulty: directDiff } };
    }

    const directNumber = parseStrictInteger(args[0]);
    if (directNumber !== null && args.length === 1) {
      if (directNumber < 1 || directNumber > 200) {
        return {
          commandName,
          subcommand: 'play',
          options: {},
          error: 'Angka tebakan harus antara 1 sampai 200.',
        };
      }
      return { commandName, subcommand: 'play', options: { number: directNumber } };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Format \`${prefix}guess\` tidak dikenali. Contoh: \`${prefix}guess\`, \`${prefix}guess 42\`, atau \`${prefix}guess challenge @teman\`.`,
    };
  }

  if (commandName === GAME_TYPES.RPS) {
    if (args.length === 0) {
      return {
        commandName,
        subcommand: null,
        options: {},
        error: `Gunakan \`${prefix}rps <rock|paper|scissors>\`, \`${prefix}rps challenge @teman\`, atau \`${prefix}rps choose <pilihan>\`.`,
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
      error: `Format \`${prefix}rps\` tidak valid. Gunakan \`${prefix}rps <rock|paper|scissors>\` atau \`${prefix}rps challenge @teman\`.`,
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
      error: `Format \`${prefix}coinflip\` tidak valid. Gunakan \`${prefix}coinflip <heads|tails>\` atau \`${prefix}coinflip challenge @teman\`.`,
    };
  }

  if (commandName === GAME_TYPES.DICE) {
    if (args.length === 0) {
      return {
        commandName,
        subcommand: 'solo',
        options: { count: DICE_CONFIG.DEFAULT_COUNT, sides: DICE_CONFIG.DEFAULT_SIDES },
      };
    }

    if (firstLower === 'solo') {
      const parsedDice = parseDiceArgs(args.slice(1), prefix);
      if (parsedDice.error) {
        return { commandName, subcommand: 'solo', options: {}, error: parsedDice.error };
      }
      return { commandName, subcommand: 'solo', options: parsedDice };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}dice challenge @teman 2d6\`.`,
        };
      }
      const parsedDice = parseDiceArgs(args.slice(2), prefix);
      if (parsedDice.error) {
        return { commandName, subcommand: 'challenge', options: {}, error: parsedDice.error };
      }
      return {
        commandName,
        subcommand: 'challenge',
        options: { opponentId, ...parsedDice },
      };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId) {
      const parsedDice = parseDiceArgs(args.slice(1), prefix);
      if (parsedDice.error) {
        return { commandName, subcommand: 'challenge', options: {}, error: parsedDice.error };
      }
      return {
        commandName,
        subcommand: 'challenge',
        options: { opponentId: directMentionId, ...parsedDice },
      };
    }

    const parsedDice = parseDiceArgs(args, prefix);
    if (parsedDice.error) {
      return { commandName, subcommand: 'solo', options: {}, error: parsedDice.error };
    }
    return { commandName, subcommand: 'solo', options: parsedDice };
  }

  if (commandName === GAME_TYPES.TICTACTOE) {
    if (args.length === 0) {
      return { commandName, subcommand: 'solo', options: { difficulty: 'normal' } };
    }

    if (firstLower === 'solo') {
      const diff = args[1] ? parseDifficulty(args[1]) : 'normal';
      if (!diff || args.length > 2) {
        return {
          commandName,
          subcommand: 'solo',
          options: {},
          error: `Gunakan \`${prefix}tictactoe solo [easy|normal|hard]\`.`,
        };
      }
      return { commandName, subcommand: 'solo', options: { difficulty: diff } };
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

    if (firstLower === 'move') {
      const pos = args[1]?.toUpperCase() ?? '';
      if (!TTT_POSITION_SET.has(pos) || args.length > 2) {
        return {
          commandName,
          subcommand: 'move',
          options: {},
          error: `Koordinat tidak valid. Pilih A1–C3. Contoh: \`${prefix}tictactoe move B2\`.`,
        };
      }
      return { commandName, subcommand: 'move', options: { position: pos } };
    }

    const directDiff = parseDifficulty(firstLower);
    if (directDiff && args.length === 1) {
      return { commandName, subcommand: 'solo', options: { difficulty: directDiff } };
    }

    const directPos = args[0].toUpperCase();
    if (TTT_POSITION_SET.has(directPos) && args.length === 1) {
      return { commandName, subcommand: 'move', options: { position: directPos } };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Format \`${prefix}tictactoe\` tidak dikenali. Contoh: \`${prefix}tictactoe\`, \`${prefix}tictactoe B2\`, atau \`${prefix}tictactoe challenge @teman\`.`,
    };
  }

  if (commandName === GAME_TYPES.CONNECT4) {
    if (args.length === 0) {
      return { commandName, subcommand: 'solo', options: { difficulty: 'normal' } };
    }

    if (firstLower === 'solo') {
      const diff = args[1] ? parseDifficulty(args[1]) : 'normal';
      if (!diff || args.length > 2) {
        return {
          commandName,
          subcommand: 'solo',
          options: {},
          error: `Gunakan \`${prefix}connect4 solo [easy|normal|hard]\`.`,
        };
      }
      return { commandName, subcommand: 'solo', options: { difficulty: diff } };
    }

    if (firstLower === 'challenge') {
      const opponentId = extractMentionOrId(args[1]);
      if (!opponentId || args.length > 2) {
        return {
          commandName,
          subcommand: 'challenge',
          options: {},
          error: `Mention lawan yang valid. Contoh: \`${prefix}connect4 challenge @teman\`.`,
        };
      }
      return { commandName, subcommand: 'challenge', options: { opponentId } };
    }

    const directMentionId = extractMentionOrId(args[0]);
    if (directMentionId && args.length === 1) {
      return { commandName, subcommand: 'challenge', options: { opponentId: directMentionId } };
    }

    if (firstLower === 'drop') {
      const col = parseStrictInteger(args[1]);
      if (col === null || col < 1 || col > 7 || args.length > 2) {
        return {
          commandName,
          subcommand: 'drop',
          options: {},
          error: `Nomor kolom harus antara 1 sampai 7. Contoh: \`${prefix}connect4 drop 4\`.`,
        };
      }
      return { commandName, subcommand: 'drop', options: { column: col } };
    }

    const directDiff = parseDifficulty(firstLower);
    if (directDiff && args.length === 1) {
      return { commandName, subcommand: 'solo', options: { difficulty: directDiff } };
    }

    const directCol = parseStrictInteger(args[0]);
    if (directCol !== null && args.length === 1) {
      if (directCol < 1 || directCol > 7) {
        return {
          commandName,
          subcommand: 'drop',
          options: {},
          error: 'Nomor kolom harus antara 1 sampai 7.',
        };
      }
      return { commandName, subcommand: 'drop', options: { column: directCol } };
    }

    return {
      commandName,
      subcommand: null,
      options: {},
      error: `Format \`${prefix}connect4\` tidak dikenali. Contoh: \`${prefix}connect4\`, \`${prefix}connect4 4\`, atau \`${prefix}connect4 challenge @teman\`.`,
    };
  }

  return null;
}
