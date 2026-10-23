const { Schema, model } = require("mongoose");

const radioStreamSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    voiceChannelId: { type: String, default: null },
    streamUrl: { type: String, default: null },
    streamType: { type: String, default: "mp3" },
    reconnectMinutes: { type: Number, default: 15 },
    status: {
      type: String,
      enum: ["offline", "starting", "playing", "reconnecting", "error"],
      default: "offline",
    },
    statusMessage: { type: String, default: null },
    lastConnectedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

module.exports = model("RadioStream", radioStreamSchema);
