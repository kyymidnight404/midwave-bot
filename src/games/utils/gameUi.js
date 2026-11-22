import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS } from '../../config/colors.js';
import { GAME_CENTER_LABELS } from '../services/scoreService.js';
import {
  QUIZ_MAX_PLAYERS,
  QUIZ_TOTAL_QUESTIONS,
  sanitizeQuizImageUrl,
} from '../engines/quizBattle.js';
import { getIconAttachmentUrl } from '../../utils/embeds.js';
import { buildGameCustomId } from './customId.js';

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

const QUIZ_CATEGORY_LABELS = Object.freeze({
  all: 'Semua',
  general: 'Umum',
  science: 'Sains',
  technology: 'Teknologi',
  geography: 'Geografi',
  history: 'Sejarah',
  sports: 'Olahraga',
});

const QUIZ_DIFFICULTY_LABELS = Object.freeze({
  all: 'Semua',
  easy: 'Mudah',
  normal: 'Normal',
  hard: 'Sulit',
});

function formatQuizCategory(category) {
  return QUIZ_CATEGORY_LABELS[category] ?? category ?? 'Umum';
}

function formatQuizDifficulty(difficulty) {
  return QUIZ_DIFFICULTY_LABELS[difficulty] ?? difficulty ?? 'Normal';
}

function applyMidwaveBranding(embed, includeThumbnail = true, iconName = null) {
  if (includeThumbnail) {
    embed.setThumbnail(getIconAttachmentUrl(iconName));
  }
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
  includeThumbnail = true,
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
    gameType,
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
  includeThumbnail = true,
}) {
  const pX = state.players.X;
  const pO = state.players.O;
  const winSet = new Set(state.winningLine ?? []);
  const isFinished = status === 'finished' || Boolean(state.winnerId) || state.isDraw;

  let statusLine = `Giliran: <@${state.currentTurnId}> (${state.currentTurn === 'X' ? '❌' : '⭕'})`;
  let color = COLORS.PRIMARY;

  if (forfeitedById) {
    statusLine = `🏳️ <@${forfeitedById}> menyerah! Pemenang: <@${state.winnerId}>`;
    color = COLORS.SUCCESS;
  } else if (state.winnerId) {
    statusLine = `🏆 Pemenang: <@${state.winnerId}> (${state.winnerSymbol === 'X' ? '❌' : '⭕'})!`;
    color = COLORS.SUCCESS;
  } else if (state.isDraw) {
    statusLine = '🤝 Pertandingan berakhir **Seri**!';
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
    'tic-tac-toe',
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
  includeThumbnail = true,
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
    statusText = `🏳️ <@${forfeitedById}> menyerah! Pemenang: <@${state.winnerId}>`;
    color = COLORS.SUCCESS;
  } else if (state.winnerId) {
    statusText = `🏆 Pertandingan Selesai! Pemenang: <@${state.winnerId}>`;
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
    'rps',
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
  includeThumbnail = true,
}) {
  const playerList =
    state.players.length > 0
      ? state.players.map((id, i) => `${i + 1}. <@${id}>${id === state.hostId ? ' *(Host)*' : ''}`).join('\n')
      : '*Tidak ada pemain*';

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(cancelledText ? COLORS.ERROR : COLORS.PRIMARY)
      .setTitle('🧠 Quiz Battle — Lobi')
      .setDescription(
        cancelledText ??
          `**Host:** <@${state.hostId}>\n` +
            `**Kategori:** \`${formatQuizCategory(state.category)}\` | **Kesulitan:** \`${formatQuizDifficulty(state.difficulty)}\`\n` +
            `**Aturan:** ${QUIZ_TOTAL_QUESTIONS} soal • 20 detik/ronde\n\n` +
            `**Pemain (${state.players.length}/${QUIZ_MAX_PLAYERS}):**\n${playerList}`,
      ),
    includeThumbnail,
    'quiz',
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'join'))
      .setLabel('Gabung')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || state.players.length >= QUIZ_MAX_PLAYERS),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'leave'))
      .setLabel('Keluar')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'start'))
      .setLabel('Mulai')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'cancel'))
      .setLabel('Batal')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Global Channel Quiz Lobby UI (no opponent selection, no participant counts).
 */
export function buildGlobalQuizLobbyMessage({
  sessionId,
  disabled = false,
  statusOverride = null,
  includeThumbnail = true,
}) {
  let color = COLORS.PRIMARY;
  let description =
    'Test your knowledge with exciting questions! Answer correctly and compete with others in this channel.';

  if (statusOverride === 'expired') {
    color = COLORS.WARNING;
    description = `${description}\n\n⏱️ Lobby kedaluwarsa karena tidak digunakan.`;
  } else if (statusOverride === 'cancelled') {
    color = COLORS.ERROR;
    description = `${description}\n\n❌ Quiz dibatalkan.`;
  }

  const embed = applyMidwaveBranding(
    new EmbedBuilder().setColor(color).setTitle('Quiz').setDescription(description),
    includeThumbnail,
    'quiz',
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'start_global'))
      .setLabel('Start Quiz')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Quiz Battle Active Question UI (answer is strictly hidden, no participant answer count).
 */
export function buildQuizQuestionMessage({
  sessionId,
  state,
  includeThumbnail = true,
  includeImage = true,
}) {
  const q = state.questions[state.round - 1];
  const endsUnix = Math.floor((state.roundEndsAt ?? Date.now() + 20_000) / 1000);

  const optionsText = q.options
    .map((opt, idx) => `**${OPTION_LETTERS[idx]}.** ${opt}`)
    .join('\n');

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.PRIMARY)
      .setTitle(`🧠 Quiz Battle — Pertanyaan ${state.round}/${state.totalQuestions}`)
      .setDescription(
        `📚 **Kategori:** \`${formatQuizCategory(q.category)}\` | ⚡ **Kesulitan:** \`${formatQuizDifficulty(q.difficulty)}\`\n` +
          `⏱️ **Berakhir:** <t:${endsUnix}:R>\n\n` +
          `**${q.question}**\n\n` +
          `${optionsText}\n\n` +
          '💬 Ketik **a**, **b**, **c**, atau **d** langsung di chat untuk menjawab!',
      ),
    includeThumbnail,
    'quiz',
  );

  const questionImageUrl = includeImage ? sanitizeQuizImageUrl(q?.imageUrl ?? q?.image) : null;
  if (questionImageUrl) {
    embed.setImage(questionImageUrl);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildGameCustomId('quiz', sessionId, 'cancel'))
      .setLabel('Hentikan Quiz')
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger),
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
  includeThumbnail = true,
}) {
  const q = state.questions[state.round - 1];
  const correctLetter = OPTION_LETTERS[summary.correctIndex];
  const correctList =
    summary.correctPlayerIds.length > 0
      ? summary.correctPlayerIds.map((id) => `<@${id}>`).join(', ')
      : '*Tidak ada*';

  const leaderboardLines = summary.standings
    .slice(0, 10)
    .map((row, idx) => `${idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`} <@${row.userId}> — **${row.score}** benar`)
    .join('\n');

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle(`📊 Hasil Ronde ${state.round}/${state.totalQuestions}`)
      .setDescription(
        `**Pertanyaan:** ${q.question}\n` +
          `✅ **Jawaban Benar:** **${correctLetter}.** ${summary.correctOption}\n` +
          `🎯 **Menjawab Benar:** ${correctList}\n\n` +
          `**Hasil Sementara:**\n${leaderboardLines}\n\n` +
          (state.round < state.totalQuestions
            ? '*Pertanyaan berikutnya segera dimulai...*'
            : '*Menghitung hasil akhir...*'),
      ),
    includeThumbnail,
    'quiz',
  );

  return { embeds: [embed], components: [] };
}

/**
 * Quiz Battle Final Podium UI.
 */
export function buildQuizFinalMessage({
  state,
  standings,
  includeThumbnail = true,
}) {
  const isSolo = standings.length <= 1;
  const totalQuestions = state.totalQuestions ?? QUIZ_TOTAL_QUESTIONS;
  const leaderboardLines = standings
    .map((row, idx) => {
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
      return `${medal} <@${row.userId}> — **${row.score}/${totalQuestions}** benar`;
    })
    .join('\n');

  const headerLine = isSolo
    ? `🏁 **Quiz Selesai!** Jawaban benar <@${standings[0]?.userId ?? state.hostId}>: **${standings[0]?.score ?? 0}/${totalQuestions}**.`
    : state.winnerId
      ? `🏆 **Pemenang Quiz Battle:** <@${state.winnerId}>!`
      : '🤝 **Quiz Battle berakhir Seri!**';

  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle('🏆 Quiz Battle — Hasil Akhir')
      .setDescription(`${headerLine}\n\n**Ringkasan Jawaban:**\n${leaderboardLines}`),
    includeThumbnail,
    'quiz',
  );

  return { embeds: [embed], components: [] };
}

/**
 * Cancelled Quiz Battle UI when Host stops an active match early.
 */
export function buildQuizCancelledMessage({
  state,
  cancelledById,
  includeThumbnail = true,
}) {
  const embed = applyMidwaveBranding(
    new EmbedBuilder()
      .setColor(COLORS.DANGER)
      .setTitle('🧠 Quiz Battle — Dihentikan')
      .setDescription(`❌ Quiz dihentikan oleh Host (<@${cancelledById ?? state?.hostId}>) pada ronde ${state?.round ?? 1}/${state?.totalQuestions ?? QUIZ_TOTAL_QUESTIONS}.`),
    includeThumbnail,
    'quiz',
  );

  return { embeds: [embed], components: [] };
}
