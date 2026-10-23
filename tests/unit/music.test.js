const { test, ok } = require("./_harness");
const {
  normalizeMediaQuery,
  isPlayableUrl,
  pauseGuildMusic,
  resumeGuildMusic,
  skipGuildMusic,
  enqueueGuildTrack,
  getGuildQueue,
  getNowPlaying,
  getGuildMusicState,
  guildPlayers,
  playGuildMusic,
  advanceGuildQueue,
  clearGuildQueue,
} = require("../../src/systems/music");

test("normalizeMediaQuery trims whitespace and preserves playable URLs", async () => {
  const normalized = normalizeMediaQuery("  https://example.com/song.mp3  ");
  ok(normalized === "https://example.com/song.mp3", "URLs should be preserved exactly once trimmed");
});

test("isPlayableUrl accepts direct audio URLs and rejects empty input", async () => {
  ok(isPlayableUrl("https://example.com/song.mp3") === true, "direct audio URLs should be accepted");
  ok(isPlayableUrl("   ") === false, "blank values should be rejected");
});

test("pause/resume/skip control the playback lifecycle", async () => {
  const fakeSession = {
    player: {
      pause: () => {
        fakeSession.player.state = { status: "paused" };
      },
      unpause: () => {
        fakeSession.player.state = { status: "playing" };
      },
      stop: () => {
        fakeSession.player.state = { status: "stopped" };
      },
      state: { status: "playing" },
    },
    connection: { destroy: () => {} },
    channelId: "channel-1",
    lastTrack: { title: "Song" },
  };

  guildPlayers.set("guild-1", fakeSession);

  const paused = await pauseGuildMusic("guild-1");
  ok(paused.ok === true && paused.status === "paused", "pause should mark the session as paused");

  const resumed = await resumeGuildMusic("guild-1");
  ok(resumed.ok === true && resumed.status === "playing", "resume should restore playback");

  const skipped = await skipGuildMusic("guild-1");
  ok(skipped.ok === true && skipped.status === "skipped", "skip should flag the session as skipped");

  const state = getGuildMusicState("guild-1");
  ok(state.ok === false || state.status === "stopped", "skip should leave the guild without a live session");

  guildPlayers.delete("guild-1");
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

  const cleared = await skipGuildMusic("guild-2");
  ok(cleared.ok === true || cleared.status === "skipped", "skip should clear the active tracked state");
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
  skipGuildMusic("guild-3");
});

test("advance and clear queue manage the queued track list", async () => {
  await enqueueGuildTrack("guild-4", { title: "First queued", url: "https://example.com/first.mp3" });
  await enqueueGuildTrack("guild-4", { title: "Second queued", url: "https://example.com/second.mp3" });

  const advanced = await advanceGuildQueue("guild-4");
  ok(advanced.ok === true && advanced.nextTitle === "Second queued", "advance should promote the next queued track");

  const cleared = await clearGuildQueue("guild-4");
  ok(cleared.ok === true && cleared.cleared === 1, "clear should remove the remaining queued items");
});
