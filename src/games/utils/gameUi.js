import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS, EMBED_FOOTER, LOGO_ATTACHMENT_URL } from '../../utils/constants.js';
import { GAME_CENTER_LABELS } from '../services/scoreService.js';
import { QUIZ_MAX_PLAYERS, QUIZ_TOTAL_QUESTIONS } from '../engines/quizBattle.js';
import { buildGameCustomId } from './customId.js';

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
const OPTION_EMOJIS = ['🇦', '🇧', '🇨', '🇩'];
const COL_NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

function applyMidwaveBranding(embed, includeThumbnail = false) {
  embed.setFooter({
    text: `${EMBED_FOOTER} • Game Center`,
    ...(includeThumbnail ? { iconURL: LOGO_ATTACHMENT_URL } : {}),
  });
  if (includeThumbnail) {
    embed.setThumbnail(LOGO_ATTACHMENT_URL);
  }
  embed.setTimestamp();
  return embed;
}

/**
 * Challenge Prompt UI (Accept / Decline).
 */
export function buildChallengeMessage({
  sessionId,
  gameType,
  hostId,
  opponentId,
  disabled = false,
  statusText = null,
  color = COLORS.PRIMARY,
  includeThumbnail = false,
}) {
  const gameTitle = GAME_CENTER_LABELS[gameType] ?? gameType;
  const description =
    statusText ??
    `<@${hostId}> menantang <@${opponentId}> untuk bermain **${gameTitle}**!\n\n` +
      `Klik **Terima** untuk memulai permainan atau **Tolak** untuk membatalkan.\n` +
      `*Tantangan berlaku selama 2 menit.*`;

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(color)
      .setTitle(`🎮 Tantangan ${gameTitle}`)
      .setDescription(description),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('challenge', sessionId, 'accept'))
      .setLabel('Terima')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('challenge', sessionId, 'decline'))
      .setLabel('Tolak')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Tic Tac Toe 3x3 Button Board UI.
 */
export function buildTicTacToeMessage({
  sessionId,
  state,
  status = 'active',
  forfeitedById = null,
  includeThumbnail = false,
}) {
  const pX = state.players.X;
  const pO = state.players.O;
  const winSet = new Set(state.winningLine ?? []);
  const isFinished = status === 'finished' || Boolean(state.winnerId) || state.isDraw;

  let statusLine = `Giliran: <@${state.currentTurnId}> (${state.currentTurn === 'X' ? '❌' : '⭕'})`;
  let color = COLORS.PRIMARY;

  if (forfeitedById) {
    statusLine = `🏳️ <@${forfeitedById}> menyerah! Pemenang: <@${state.winnerId}> (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (state.winnerId) {
    statusLine = `🏆 Pemenang: <@${state.winnerId}> (${state.winnerSymbol === 'X' ? '❌' : '⭕'})! (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (state.isDraw) {
    statusLine = '🤝 Pertandingan berakhir **Seri**! (+10 poin masing-masing)';
    color = COLORS.WARNING;
  } else if (status === 'expired') {
    statusLine = '⏱️ Pertandingan berakhir karena tidak ada aktivitas.';
    color = COLORS.MUTED;
  }

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(color)
      .setTitle('⭕ Tic Tac Toe — Game Center')
      .setDescription(
        `❌ **Pemain X:** <@${pX}>\n` +
          `⭕ **Pemain O:** <@${pO}>\n\n` +
          `${statusLine}`,
      ),
    includeThumbnail,
  );

  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c += 1) {
      const idx = r * 3 + c;
      const cell = state.board[idx];
      let label = '\u200B';
      let emoji = '⬜';
      let style = ButtonStyle.Secondary;

      if (cell === 'X') {
        emoji = '❌';
        style = winSet.has(idx) ? ButtonStyle.Success : ButtonStyle.Primary;
      } else if (cell === 'O') {
        emoji = '⭕';
        style = winSet.has(idx) ? ButtonStyle.Success : ButtonStyle.Danger;
      }

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(buildGameCustomId('ttt', sessionId, 'move', idx))
          .setLabel(label)
          .setEmoji(emoji)
          .setStyle(style)
          .setDisabled(isFinished || status === 'expired' || cell !== null),
      );
    }
    rows.push(row);
  }

  if (!isFinished && status === 'active') {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(buildGameCustomId('ttt', sessionId, 'forfeit'))
          .setLabel('Menyerah')
          .setEmoji('🏳️')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return { embeds: [embed], components: rows };
}

/**
 * Connect Four 7x6 Visual Board + Column Buttons UI.
 */
export function buildConnectFourMessage({
  sessionId,
  state,
  status = 'active',
  forfeitedById = null,
  includeThumbnail = false,
}) {
  const pR = state.players.R;
  const pY = state.players.Y;
  const isFinished = status === 'finished' || Boolean(state.winnerId) || state.isDraw;

  let statusLine = `Giliran: <@${state.currentTurnId}> (${state.currentTurn === 'R' ? '🔴' : '🟡'})`;
  let color = COLORS.PRIMARY;

  if (forfeitedById) {
    statusLine = `🏳️ <@${forfeitedById}> menyerah! Pemenang: <@${state.winnerId}> (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (state.winnerId) {
    statusLine = `🏆 Pemenang: <@${state.winnerId}> (${state.winnerSymbol === 'R' ? '🔴' : '🟡'})! (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (state.isDraw) {
    statusLine = '🤝 Papan penuh — Pertandingan **Seri**! (+10 poin masing-masing)';
    color = COLORS.WARNING;
  } else if (status === 'expired') {
    statusLine = '⏱️ Pertandingan berakhir karena tidak ada aktivitas.';
    color = COLORS.MUTED;
  }

  const boardLines = state.board.map((row) =>
    row.map((cell) => (cell === 'R' ? '🔴' : cell === 'Y' ? '🟡' : '⚪')).join(' '),
  );
  boardLines.push(COL_NUMBERS.join(' '));

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(color)
      .setTitle('🔴🟡 Connect Four — Game Center')
      .setDescription(
        `🔴 **Merah:** <@${pR}> | 🟡 **Kuning:** <@${pY}>\n` +
          `${statusLine}\n\n` +
          `${boardLines.join('\n')}`,
      ),
    includeThumbnail,
  );

  const row1 = new ActionRowBuilder();
  for (let col = 0; col < 4; col += 1) {
    const colFull = state.board[0][col] !== null;
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(buildGameCustomId('c4', sessionId, 'drop', col))
        .setLabel(`${col + 1}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(isFinished || status === 'expired' || colFull),
    );
  }

  const row2 = new ActionRowBuilder();
  for (let col = 4; col < 7; col += 1) {
    const colFull = state.board[0][col] !== null;
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(buildGameCustomId('c4', sessionId, 'drop', col))
        .setLabel(`${col + 1}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(isFinished || status === 'expired' || colFull),
    );
  }
  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('c4', sessionId, 'forfeit'))
      .setLabel('Menyerah')
      .setEmoji('🏳️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFinished || status === 'expired'),
  );

  return { embeds: [embed], components: [row1, row2] };
}

const RPS_EMOJI = Object.freeze({
  rock: '🪨 Rock',
  paper: '📄 Paper',
  scissors: '✂️ Scissors',
});

/**
 * Rock Paper Scissors Best-of-3 UI (hides picks until both choose).
 */
export function buildRpsMessage({
  sessionId,
  state,
  status = 'active',
  forfeitedById = null,
  includeThumbnail = false,
}) {
  const p1 = state.player1Id;
  const p2 = state.player2Id;
  const s1 = state.scores[p1] ?? 0;
  const s2 = state.scores[p2] ?? 0;
  const isFinished = status === 'finished' || Boolean(state.winnerId);

  const p1Picked = Object.hasOwn(state.roundChoices ?? {}, p1);
  const p2Picked = Object.hasOwn(state.roundChoices ?? {}, p2);

  let statusText =
    `Ronde **${state.round}** (Best of 3 — target 2 menang)\n` +
    `• <@${p1}>: ${p1Picked ? '✅ Sudah memilih *(tersembunyi)*' : '⏳ Menunggu pilihan...'}\n` +
    `• <@${p2}>: ${p2Picked ? '✅ Sudah memilih *(tersembunyi)*' : '⏳ Menunggu pilihan...'}`;
  let color = COLORS.PRIMARY;

  if (forfeitedById) {
    statusText = `🏳️ <@${forfeitedById}> menyerah! Pemenang: <@${state.winnerId}> (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (state.winnerId) {
    statusText = `🏆 Pertandingan Selesai! Pemenang: <@${state.winnerId}> (+25 poin)`;
    color = COLORS.SUCCESS;
  } else if (status === 'expired') {
    statusText = '⏱️ Pertandingan berakhir karena timeout.';
    color = COLORS.MUTED;
  }

  const lastRound = state.history?.at(-1);
  const lastRoundLine = lastRound
    ? `\n\n**Hasil Ronde ${lastRound.round}:**\n` +
      `<@${p1}> (${RPS_EMOJI[lastRound.choices[p1]]}) vs <@${p2}> (${RPS_EMOJI[lastRound.choices[p2]]}) → ` +
      (lastRound.isDraw ? '🤝 Seri!' : `🏆 <@${lastRound.winnerId}> menang ronde!`)
    : '';

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(color)
      .setTitle('✊✋✌️ Rock Paper Scissors (Best of 3)')
      .setDescription(
        `**Skor:** <@${p1}> **${s1}** — **${s2}** <@${p2}>\n\n` +
          `${statusText}${lastRoundLine}`,
      ),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('rps', sessionId, 'pick', 'rock'))
      .setLabel('Rock')
      .setEmoji('🪨')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isFinished || status === 'expired'),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('rps', sessionId, 'pick', 'paper'))
      .setLabel('Paper')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isFinished || status === 'expired'),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('rps', sessionId, 'pick', 'scissors'))
      .setLabel('Scissors')
      .setEmoji('✂️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isFinished || status === 'expired'),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('rps', sessionId, 'forfeit'))
      .setLabel('Menyerah')
      .setEmoji('🏳️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFinished || status === 'expired'),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Quiz Battle Lobby UI.
 */
export function buildQuizLobbyMessage({
  sessionId,
  state,
  disabled = false,
  cancelledText = null,
  includeThumbnail = false,
}) {
  const playerList =
    state.players.length > 0
      ? state.players.map((id, i) => `${i + 1}. <@${id}>${id === state.hostId ? ' *(Host)*' : ''}`).join('\n')
      : '*Tidak ada pemain*';

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(cancelledText ? COLORS.ERROR : COLORS.PRIMARY)
      .setTitle('🧠 Quiz Battle — Lobby')
      .setDescription(
        cancelledText ??
          `**Host:** <@${state.hostId}>\n` +
            `**Kategori:** \`${state.category}\` | **Kesulitan:** \`${state.difficulty}\`\n` +
            `**Aturan:** ${QUIZ_TOTAL_QUESTIONS} soal • 20 detik/ronde • +10 benar • +5 bonus pemenang\n\n` +
            `**Pemain (${state.players.length}/${QUIZ_MAX_PLAYERS}):**\n${playerList}`,
      ),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'join'))
      .setLabel('Join')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || state.players.length >= QUIZ_MAX_PLAYERS),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'leave'))
      .setLabel('Leave')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'start'))
      .setLabel('Start Game')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'cancel'))
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Quiz Battle Active Question UI (answer is strictly hidden).
 */
export function buildQuizQuestionMessage({
  sessionId,
  state,
  includeThumbnail = false,
}) {
  const q = state.questions[state.round - 1];
  const endsUnix = Math.floor((state.roundEndsAt ?? Date.now() + 20_000) / 1000);
  const answeredCount = Object.keys(state.roundAnswers ?? {}).length;

  const optionsText = q.options
    .map((opt, idx) => `${OPTION_EMOJIS[idx]} **${OPTION_LETTERS[idx]}.** ${opt}`)
    .join('\n');

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`🧠 Quiz Battle — Pertanyaan ${state.round}/${state.totalQuestions}`)
      .setDescription(
        `📚 **Kategori:** \`${q.category}\` | ⚡ **Kesulitan:** \`${q.difficulty}\`\n` +
          `⏱️ **Berakhir:** <t:${endsUnix}:R> | 👥 **Sudah menjawab:** ${answeredCount}/${state.players.length}\n\n` +
          `**${q.question}**\n\n` +
          `${optionsText}`,
      ),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    OPTION_LETTERS.map((letter, idx) =>
      new ButtonBuilder()
        .setCustomId(buildGameCustomId('quiz', sessionId, 'ans', state.round, idx))
        .setLabel(letter)
        .setEmoji(OPTION_EMOJIS[idx])
        .setStyle(ButtonStyle.Primary),
    ),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Quiz Battle Intermission / Round Result UI (reveals answer & interim leaderboard).
 */
export function buildQuizRoundResultMessage({
  sessionId,
  state,
  summary,
  includeThumbnail = false,
}) {
  const q = state.questions[state.round - 1];
  const correctLetter = OPTION_LETTERS[summary.correctIndex];
  const correctList =
    summary.correctPlayerIds.length > 0
      ? summary.correctPlayerIds.map((id) => `<@${id}>`).join(', ')
      : '*Tidak ada*';

  const leaderboardLines = summary.standings
    .slice(0, 10)
    .map((row, idx) => `${idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`} <@${row.userId}> — **${row.score}** poin`)
    .join('\n');

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`📊 Hasil Ronde ${state.round}/${state.totalQuestions}`)
      .setDescription(
        `**Pertanyaan:** ${q.question}\n` +
          `✅ **Jawaban Benar:** **${correctLetter}.** ${summary.correctOption}\n` +
          `🎯 **Menjawab Benar (+10):** ${correctList}\n\n` +
          `**Klasemen Sementara:**\n${leaderboardLines}\n\n` +
          (state.round < state.totalQuestions
            ? '*Pertanyaan berikutnya segera dimulai...*'
            : '*Menghitung hasil akhir...*'),
      ),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    OPTION_LETTERS.map((letter, idx) =>
      new ButtonBuilder()
        .setCustomId(buildGameCustomId('quiz', sessionId, 'ans', state.round, idx))
        .setLabel(letter)
        .setEmoji(OPTION_EMOJIS[idx])
        .setStyle(idx === summary.correctIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(true),
    ),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Quiz Battle Final Podium UI.
 */
export function buildQuizFinalMessage({
  state,
  standings,
  includeThumbnail = false,
}) {
  const leaderboardLines = standings
    .map((row, idx) => {
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
      const bonusTag = state.winnerId === row.userId ? ' *(+5 Bonus Juara)*' : '';
      return `${medal} <@${row.userId}> — **${row.score}** poin${bonusTag}`;
    })
    .join('\n');

  const headerLine = state.winnerId
    ? `🏆 **Pemenang Quiz Battle:** <@${state.winnerId}> (+5 bonus poin)!`
    : '🤝 **Quiz Battle berakhir Seri!**';

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle('🏆 Quiz Battle — Hasil Akhir')
      .setDescription(`${headerLine}\n\n**Klasemen Akhir:**\n${leaderboardLines}`),
    includeThumbnail,
  );

  return { embeds: [embed], components: [] };
}

/**
 * Leaderboard Embed + Pagination Buttons UI.
 */
export function buildLeaderboardMessage({
  requesterId,
  leaderboard,
  includeThumbnail = false,
}) {
  const scopeLabel =
    leaderboard.gameType === 'all'
      ? 'Overall (Semua Game)'
      : GAME_CENTER_LABELS[leaderboard.gameType] ?? leaderboard.gameType;

  const lines =
    leaderboard.entries.length > 0
      ? leaderboard.entries.map((entry) => {
          const medal =
            entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `**#${entry.rank}**`;
          return `${medal} <@${entry.userId}> — **${entry.points}** poin • **${entry.wins}** menang (${entry.matches} main, ${entry.winRate}% WR)`;
        })
      : ['Belum ada pertandingan selesai yang tercatat di server ini.'];

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`🏆 Leaderboard — ${scopeLabel}`)
      .setDescription(lines.join('\n'))
      .addFields({
        name: 'Info',
        value: `Halaman **${leaderboard.page}/${leaderboard.totalPages}** • Total Pemain: **${leaderboard.totalEntries}**`,
      }),
    includeThumbnail,
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        buildGameCustomId('lb', requesterId, 'page', leaderboard.gameType, Math.max(1, leaderboard.page - 1)),
      )
      .setLabel('Prev')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(leaderboard.page <= 1),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('lb', requesterId, 'info', leaderboard.gameType, leaderboard.page))
      .setLabel(`Hal ${leaderboard.page}/${leaderboard.totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(
        buildGameCustomId(
          'lb',
          requesterId,
          'page',
          leaderboard.gameType,
          Math.min(leaderboard.totalPages, leaderboard.page + 1),
        ),
      )
      .setLabel('Next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(leaderboard.page >= leaderboard.totalPages),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * User Profile Statistics Embed UI.
 */
export function buildProfileMessage({
  targetUser,
  profile,
  includeThumbnail = false,
}) {
  const { summary, perGame } = profile;
  const displayName = targetUser?.username ?? targetUser?.tag ?? `<@${profile.userId}>`;

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`📊 Profil Game Center — ${displayName}`)
      .setDescription(
        `Pemain: <@${profile.userId}>\n` +
          `🏅 **Total Poin:** **${summary.points}**\n` +
          `🎮 **Total Pertandingan:** **${summary.matches}**\n` +
          `✅ **Menang:** ${summary.wins} | ❌ **Kalah:** ${summary.losses} | 🤝 **Seri:** ${summary.draws}\n` +
          `📈 **Win Rate:** **${summary.winRate}%**`,
      ),
    includeThumbnail,
  );

  if (targetUser?.displayAvatarURL) {
    embed.setThumbnail(targetUser.displayAvatarURL());
  }

  for (const [gameKey, label] of Object.entries(GAME_CENTER_LABELS)) {
    const stat = perGame[gameKey];
    embed.addFields({
      name: label,
      value:
        `Main: **${stat.matches}** | M/K/S: **${stat.wins}/${stat.losses}/${stat.draws}**\n` +
        `Win Rate: **${stat.winRate}%** | Poin: **${stat.points}**`,
      inline: true,
    });
  }

  return { embeds: [embed], components: [] };
}
