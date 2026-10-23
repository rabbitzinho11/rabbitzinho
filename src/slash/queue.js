const { safeReply } = require("../utils/discord");
const { getGuildQueue } = require("../systems/music");

module.exports = async function queueSlash(_client, interaction) {
  try {
    if (!interaction?.guild) return;

    const queue = getGuildQueue(interaction.guild.id);
    if (!queue.length) {
      return safeReply(
        interaction,
        { content: "📋 A fila está vazia no momento." },
        { ephemeral: true },
      );
    }

    const items = queue
      .slice(0, 5)
      .map((track, index) => `${index + 1}. ${track.title || "Unknown"}`)
      .join("\n");

    return safeReply(
      interaction,
      { content: `📋 Próximas faixas:\n${items}` },
      { ephemeral: true },
    );
  } catch (err) {
    console.error("[slash/queue] Error:", err);
    return safeReply(
      interaction,
      { content: "Ocorreu um erro ao consultar a fila." },
      { ephemeral: true },
    );
  }
};
