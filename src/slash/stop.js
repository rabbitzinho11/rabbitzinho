const { safeReply } = require("../utils/discord");
const { stopGuildMusic } = require("../systems/music");

module.exports = async function stopSlash(_client, interaction) {
  try {
    if (!interaction?.guild) return;

    const result = await stopGuildMusic(interaction.guild.id);
    const message = result.ok
      ? "⏹️ Reprodução parada e canal de voz encerrado."
      : "Não havia reprodução ativa para parar.";

    return safeReply(
      interaction,
      { content: message },
      { ephemeral: true },
    );
  } catch (err) {
    console.error("[slash/stop] Error:", err);
    return safeReply(
      interaction,
      { content: "Ocorreu um erro ao parar a reprodução." },
      { ephemeral: true },
    );
  }
};
