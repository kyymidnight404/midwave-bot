import { MessageFlags } from 'discord.js';
import {
  KNOWLEDGE_CATEGORIES,
  KnowledgeServiceError,
  defaultKnowledgeStore,
} from '../services/knowledge/index.js';
import { COLORS } from '../config/colors.js';
import {
  buildErrorEmbed,
  buildInfoEmbed,
  buildSuccessEmbed,
  buildWarningEmbed,
  createBaseEmbed,
} from '../utils/embeds.js';

/**
 * Executes `!knowledge` prefix subcommands cleanly with strict Discord User ID authorization
 * for all Global Bot Knowledge management operations.
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
    store._assertAdmin(auth);

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
            buildWarningEmbed(
              'Tidak ada entri knowledge yang cocok dengan pencarian tersebut.',
              'Global Bot Knowledge',
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
          buildSuccessEmbed(
            `Berhasil memuat ulang **${reloaded.entries.length}** entri Global Bot Knowledge dari penyimpanan persisten.`,
            'Knowledge Reloaded',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'add') {
      const id = interaction.options.getString('id', false)?.trim();
      const category = interaction.options.getString('category', false)?.trim();
      const title = interaction.options.getString('title', false)?.trim();
      const content = interaction.options.getString('content', false)?.trim();
      if (!id || !category || !title || !content) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Aksi `add` membutuhkan parameter `id`, `category`, `title`, dan `content`.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const entry = store.addEntry(
        {
          id,
          category,
          title,
          content,
          tags: interaction.options.getString('tags', false) ?? '',
          verificationStatus: interaction.options.getString('status', false) ?? 'verified',
        },
        auth,
      );

      await interaction.reply({
        embeds: [
          buildSuccessEmbed(
            `Entri \`${entry.id}\` (**${entry.title}**) berhasil disimpan secara persisten pada kategori \`${entry.category}\`.`,
            'Global Knowledge Ditambahkan',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'update') {
      const id = interaction.options.getString('id', false)?.trim();
      if (!id) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Aksi `update` membutuhkan parameter `id`.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

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

      const updated = store.updateEntry(id, patch, auth);
      await interaction.reply({
        embeds: [
          buildSuccessEmbed(
            `Entri \`${updated.id}\` (**${updated.title}**) berhasil diperbarui dan disimpan.`,
            'Global Knowledge Diperbarui',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'list') {
      const category = interaction.options.getString('category', false) ?? undefined;
      const entries = store.search('', { category, limit: 25 });

      if (entries.length === 0) {
        await interaction.reply({
          embeds: [
            buildWarningEmbed(
              'Belum ada entri knowledge pada filter kategori tersebut.',
              'Daftar Global Bot Knowledge',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const lines = entries.map((entry) => {
        const catLabel = KNOWLEDGE_CATEGORIES[entry.category] ?? entry.category;
        return `• \`${entry.id}\` — **${entry.title}** (${catLabel} • *${entry.verificationStatus}*)`;
      });
      const description = lines.join('\n').slice(0, 4000);
      await interaction.reply({
        embeds: [
          buildInfoEmbed(
            `Daftar Global Bot Knowledge (${entries.length})`,
            description,
            COLORS.SECONDARY,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'delete' || sub === 'remove') {
      const id = interaction.options.getString('id', false)?.trim();
      if (!id) {
        await interaction.reply({
          embeds: [buildErrorEmbed('Aksi `remove` membutuhkan parameter `id`.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const removed = store.deleteEntry(id, auth);
      await interaction.reply({
        embeds: [
          buildSuccessEmbed(
            `Entri \`${removed.id}\` (**${removed.title}**) telah dihapus dari penyimpanan persisten.`,
            'Global Knowledge Dihapus',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [buildErrorEmbed(`Subcommand \`!knowledge ${sub}\` tidak dikenali.`)],
      flags: MessageFlags.Ephemeral,
    });
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

export default { name: 'knowledge', execute };
