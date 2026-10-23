const { test, ok } = require("./_harness");
const {
  normalizeMediaQuery,
  isPlayableUrl,
  enqueueGuildTrack,
  getGuildQueue,
  getNowPlaying,
  guildPlayers,
  playGuildMusic,
  stopGuildMusic,
} = require("../../src/systems/music");

test("normalizeMediaQuery trims whitespace and preserves playable URLs", async () => {
  const normalized = normalizeMediaQuery("  https://example.com/song.mp3  ");
  ok(normalized === "https://example.com/song.mp3", "URLs should be preserved exactly once trimmed");
});

test("isPlayableUrl accepts direct audio URLs and rejects empty input", async () => {
  ok(isPlayableUrl("https://example.com/song.mp3") === true, "direct audio URLs should be accepted");
  ok(isPlayableUrl("   ") === false, "blank values should be rejected");
});

test("queue tracks and expose the current track", async () => {
  const queued = await enqueueGuildTrack("guild-2", { title: "First track", url: "https://example.com/first.mp3" });
  ok(queued.ok === true && queued.queueLength === 1, "enqueue should add a track to the guild queue");

  const second = await enqueueGuildTrack("guild-2", { title: "Second track", url: "https://example.com/second.mp3" });
  ok(second.ok === true && second.queueLength === 2, "the queue should grow with each track");

  const nowPlaying = getNowPlaying("guild-2");
  ok(nowPlaying && nowPlaying.title === "First track", "the first queued item should be the current track");

  const queue = getGuildQueue("guild-2");
  ok(Array.isArray(queue) && queue.length === 2, "queue access should return the guild queue");

  const stopped = await stopGuildMusic("guild-2");
  ok(stopped.ok === true && stopped.status === "stopped", "stop should clear the active tracked state");
});

test("new play requests queue behind the active track instead of replacing it", async () => {
  const fakeSession = {
    player: {
      stop: () => {},
      play: () => {},
      state: { status: "playing" },
    },
    connection: { destroy: () => {} },
    channelId: "channel-1",
    lastTrack: { title: "Current track", url: "https://example.com/current.mp3" },
  };

  guildPlayers.set("guild-3", fakeSession);

  const result = await playGuildMusic({
    client: { guilds: { cache: new Map(), fetch: async () => ({ voiceAdapterCreator: "adapter" }) } },
    guildId: "guild-3",
    channelId: "channel-1",
    query: "https://example.com/next.mp3",
  });

  ok(result.ok === true && result.status === "queued", "a second play request should queue instead of replace the active track");
  ok(getGuildQueue("guild-3").length === 1, "queued items should be kept in order for later playback");

  guildPlayers.delete("guild-3");
  await stopGuildMusic("guild-3");
});
