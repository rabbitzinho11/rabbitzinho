const { safeReply } = require("../utils/discord");
const { getNowPlaying } = require("../systems/music");

module.exports = async function nowPlayingSlash(_client, interaction) {
  try {
    if (!interaction?.guild) return;

    const track = getNowPlaying(interaction.guild.id);
    if (!track) {
      return safeReply(
        interaction,
        { content: "🎵 Ainda não há nada a tocar." },
        { ephemeral: true },
      );
    }

    return safeReply(
      interaction,
      { content: `🎵 Agora a tocar: ${track.title || "Unknown"}` },
      { ephemeral: true },
    );
  } catch (err) {
    console.error("[slash/nowplaying] Error:", err);
    return safeReply(
      interaction,
      { content: "Ocorreu um erro ao consultar a faixa atual." },
      { ephemeral: true },
    );
  }
};
