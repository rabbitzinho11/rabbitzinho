const { test, ok, deepEq } = require("./_harness");
const { normalizeFeature, normalizeFeatures } = require("../../src/systems/featuresService");
const { startGuildRadio, stopGuildRadio } = require("../../src/systems/radio");

test("normalizeFeature includes radio stream defaults", async () => {
  const radio = normalizeFeature("radio", {});

  deepEq(
    radio,
    {
      enabled: false,
      voiceChannelId: null,
      streamUrl: null,
      streamType: "mp3",
      reconnectMinutes: 15,
      statusMessage: null,
    },
    "radio defaults should define the stream configuration contract",
  );
});

test("normalizeFeatures carries the radio feature in the canonical schema", async () => {
  const all = normalizeFeatures({ radio: { enabled: true, streamUrl: "https://example.com/radio.mp3" } });

  ok(all.radio.enabled === true, "radio feature should remain enabled");
  ok(all.radio.streamUrl === "https://example.com/radio.mp3", "radio stream url should be preserved");
  ok(all.radio.voiceChannelId === null, "voice channel should default to null");
});

test("startGuildRadio and stopGuildRadio manage the radio lifecycle without crashing", async () => {
  const resultStart = await startGuildRadio(null, "guild-1");
  ok(resultStart.ok === false, "start should fail cleanly when no client is available");

  const resultStop = await stopGuildRadio("guild-1");
  ok(resultStop.ok === true, "stop should always resolve successfully for a known guild key");
  ok(resultStop.status === "offline", "stop should report the radio as offline");
});
