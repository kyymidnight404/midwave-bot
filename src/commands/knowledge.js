import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  KNOWLEDGE_CATEGORIES,
  KnowledgeServiceError,
  defaultKnowledgeStore,
} from '../services/knowledge/index.js';
import { COLORS } from '../utils/constants.js';
import { buildErrorEmbed, buildInfoEmbed, createBaseEmbed } from '../utils/embeds.js';

const CATEGORY_CHOICES = Object.entries(KNOWLEDGE_CATEGORIES).map(([value, name]) => ({
  name,
  value,
}));

export const data = new SlashCommandBuilder()
  .setName('knowledge')
  .setDescription('Kelola Global Bot Knowledge Midwave (khusus creator/admin terotorisasi)')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub.setName('categories').setDescription('Lihat daftar kategori Global Bot Knowledge'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('Cari entri pada Global Bot Knowledge')
      .addStringOption((opt) =>
        opt.setName('query').setDescription('Kata kunci pencarian').setRequired(false).setMaxLength(150),
      )
      .addStringOption((opt) =>
        opt
          .setName('category')
          .setDescription('Filter kategori')
          .setRequired(false)
          .addChoices(...CATEGORY_CHOICES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Tambah entri Global Bot Knowledge baru (creator/admin only)')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID unik entri (contoh: links-docs-v2)').setRequired(true).setMaxLength(64),
      )
      .addStringOption((opt) =>
        opt
          .setName('category')
          .setDescription('Kategori Global Knowledge')
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Judul entri').setRequired(true).setMaxLength(140),
      )
      .addStringOption((opt) =>
        opt.setName('content').setDescription('Isi pengetahuan bot').setRequired(true).setMaxLength(1500),
      )
      .addStringOption((opt) =>
        opt.setName('tags').setDescription('Tag dipisah koma (opsional)').setRequired(false).setMaxLength(200),
      )
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('Status verifikasi')
          .setRequired(false)
          .addChoices(
            { name: 'Verified', value: 'verified' },
            { name: 'Pending Verification', value: 'pending_verification' },
            { name: 'Unknown', value: 'unknown' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('update')
      .setDescription('Perbarui entri Global Bot Knowledge (creator/admin only)')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID entri yang akan diperbarui').setRequired(true).setMaxLength(64),
      )
      .addStringOption((opt) =>
        opt.setName('title').setDescription('Judul baru (opsional)').setRequired(false).setMaxLength(140),
      )
      .addStringOption((opt) =>
        opt.setName('content').setDescription('Isi baru (opsional)').setRequired(false).setMaxLength(1500),
      )
      .addStringOption((opt) =>
        opt
          .setName('category')
          .setDescription('Kategori baru (opsional)')
          .setRequired(false)
          .addChoices(...CATEGORY_CHOICES),
      )
      .addStringOption((opt) =>
        opt.setName('tags').setDescription('Tag baru dipisah koma (opsional)').setRequired(false).setMaxLength(200),
      )
      .addStringOption((opt) =>
        opt
          .setName('status')
          .setDescription('Status verifikasi baru (opsional)')
          .setRequired(false)
          .addChoices(
            { name: 'Verified', value: 'verified' },
            { name: 'Pending Verification', value: 'pending_verification' },
            { name: 'Unknown', value: 'unknown' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Hapus entri Global Bot Knowledge (creator/admin only)')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID entri yang akan dihapus').setRequired(true).setMaxLength(64),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('reload').setDescription('Muat ulang Global Bot Knowledge dari disk (creator/admin only)'),
  );

/**
 * Executes `/knowledge` subcommands cleanly with strict Discord User ID authorization
 * for mutating actions.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {{
 *   knowledgeStore?: import('../services/knowledge/store.js').KnowledgeStore,
 *   authorizedUserIds?: Set<string> | string[],
 *   env?: Record<string, string | undefined>,
 * }} [context]
 */
export async function execute(interaction, context = {}) {
  if (interaction.user?.bot) return;

  const store = context.knowledgeStore ?? defaultKnowledgeStore;
  const auth = {
    actorUserId: interaction.user?.id,
    authorizedUserIds: context.authorizedUserIds,
    env: context.env,
  };
  const sub = interaction.options.getSubcommand(true);

  try {
    if (sub === 'categories') {
      const categories = store.listCategories();
      const lines = categories.map(
        (cat) => `• **${cat.label}** (\`${cat.id}\`) — **${cat.entryCount}** entri\n  ${cat.description}`,
      );
      const embed = buildInfoEmbed(
        'Kategori Global Bot Knowledge',
        lines.join('\n\n'),
        COLORS.SECONDARY,
      );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'search') {
      const query = interaction.options.getString('query', false) ?? '';
      const category = interaction.options.getString('category', false) ?? undefined;
      const results = store.search(query, { category, limit: 5 });

      if (results.length === 0) {
        await interaction.reply({
          embeds: [
            buildInfoEmbed(
              'Global Bot Knowledge',
              'Tidak ada entri knowledge yang cocok dengan pencarian tersebut.',
              COLORS.WARNING,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const embed = createBaseEmbed({
        title: `Hasil Global Knowledge (${results.length})`,
        color: COLORS.SECONDARY,
        includeThumbnail: false,
      });

      for (const entry of results) {
        const catLabel = KNOWLEDGE_CATEGORIES[entry.category] ?? entry.category;
        const snippet = entry.content.length > 260 ? `${entry.content.slice(0, 257)}...` : entry.content;
        embed.addFields({
          name: `${entry.title} (\`${entry.id}\` • ${catLabel})`,
          value: `${snippet}\n*Status: ${entry.verificationStatus}*`,
        });
      }

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'reload') {
      store._assertAdmin(auth);
      const reloaded = store.reload();
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Knowledge Reloaded',
            `Berhasil memuat ulang **${reloaded.entries.length}** entri Global Bot Knowledge dari penyimpanan persisten.`,
            COLORS.SUCCESS,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'add') {
      const entry = store.addEntry(
        {
          id: interaction.options.getString('id', true),
          category: interaction.options.getString('category', true),
          title: interaction.options.getString('title', true),
          content: interaction.options.getString('content', true),
          tags: interaction.options.getString('tags', false) ?? '',
          verificationStatus: interaction.options.getString('status', false) ?? 'verified',
        },
        auth,
      );

      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Global Knowledge Ditambahkan',
            `Entri \`${entry.id}\` (**${entry.title}**) berhasil disimpan secara persisten pada kategori \`${entry.category}\`.`,
            COLORS.SUCCESS,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'update') {
      const patch = {};
      const title = interaction.options.getString('title', false);
      const content = interaction.options.getString('content', false);
      const category = interaction.options.getString('category', false);
      const tags = interaction.options.getString('tags', false);
      const status = interaction.options.getString('status', false);

      if (title !== null) patch.title = title;
      if (content !== null) patch.content = content;
      if (category !== null) patch.category = category;
      if (tags !== null) patch.tags = tags;
      if (status !== null) patch.verificationStatus = status;

      const updated = store.updateEntry(interaction.options.getString('id', true), patch, auth);
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Global Knowledge Diperbarui',
            `Entri \`${updated.id}\` (**${updated.title}**) berhasil diperbarui dan disimpan.`,
            COLORS.SUCCESS,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'delete') {
      const removed = store.deleteEntry(interaction.options.getString('id', true), auth);
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            'Global Knowledge Dihapus',
            `Entri \`${removed.id}\` (**${removed.title}**) telah dihapus dari penyimpanan persisten.`,
            COLORS.SUCCESS,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    const message =
      error instanceof KnowledgeServiceError
        ? error.message
        : 'Terjadi kesalahan saat memproses Global Bot Knowledge.';
    await interaction.reply({
      embeds: [buildErrorEmbed(message)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

export default { data, execute };
