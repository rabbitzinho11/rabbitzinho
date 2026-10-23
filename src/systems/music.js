const { Readable } = require("stream");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
} = require("@discordjs/voice");

const playDl = (() => {
  try {
    return require("play-dl");
  } catch {
    return null;
  }
})();

const guildPlayers = new Map();
const guildQueues = new Map();

function normalizeMediaQuery(value) {
  return String(value == null ? "" : value).trim();
}

function isPlayableUrl(value) {
  const raw = normalizeMediaQuery(value);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

async function resolveTrackSource(query) {
  const raw = normalizeMediaQuery(query);
  if (!raw) {
    throw new Error("EMPTY_QUERY");
  }

  if (isPlayableUrl(raw)) {
    return {
      url: raw,
      title: "Direct stream",
    };
  }

  if (!playDl || typeof playDl.search !== "function") {
    throw new Error("SEARCH_UNAVAILABLE");
  }

  const results = await playDl.search(raw, { limit: 1 });
  const first = Array.isArray(results) ? results[0] : null;
  if (!first || !first.url) {
    throw new Error("NO_RESULTS");
  }

  return {
    url: first.url,
    title: first.title || raw,
  };
}

async function createResourceFromUrl(url) {
  if (playDl && typeof playDl.stream === "function") {
    try {
      const data = await playDl.stream(url, {
        quality: 0,
        discordPlayerCompatibility: true,
      });
      const stream = data && (data.stream || data);
      if (stream) {
        return createAudioResource(stream, {
          inputType: StreamType.Arbitrary,
          inlineVolume: true,
        });
      }
    } catch (err) {
      console.warn("[music] play-dl stream failed, retrying raw HTTP stream:", err?.message || err);
    }
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`STREAM_UNAVAILABLE:${response.status || "unknown"}`);
  }

  const nodeStream = Readable.fromWeb(response.body);
  return createAudioResource(nodeStream, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  });
}

async function ensureGuildPlayer(client, guildId, channelId) {
  if (!client || !guildId || !channelId) {
    throw new Error("MISSING_CLIENT_OR_CHANNEL");
  }

  const guild =
    client.guilds?.cache?.get(guildId) ||
    (client.guilds && typeof client.guilds.fetch === "function"
      ? await client.guilds.fetch(guildId).catch(() => null)
      : null);

  if (!guild) {
    throw new Error("GUILD_NOT_FOUND");
  }

  const existing = guildPlayers.get(guildId);
  if (existing && existing.connection) {
    if (existing.connection.joinConfig?.channelId === channelId) {
      return existing;
    }
    try {
      existing.player?.stop();
      existing.connection.destroy();
    } catch {}
    guildPlayers.delete(guildId);
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  connection.subscribe(player);

  const session = { guildId, channelId, connection, player, client };
  guildPlayers.set(guildId, session);

  if (!session._queueBound) {
    session.player.on(AudioPlayerStatus.Idle, async () => {
      const queue = getGuildQueue(guildId);
      if (queue.length > 0) {
        const next = queue[0];
        guildQueues.set(guildId, queue.slice(1));
        const sessionNow = guildPlayers.get(guildId);
        if (!sessionNow) return;
        try {
          const resource = await createResourceFromUrl(next.url);
          sessionNow.player.play(resource);
          sessionNow.lastTrack = { title: next.title, url: next.url };
        } catch {
          guildQueues.delete(guildId);
        }
      } else {
        guildPlayers.delete(guildId);
      }
    });
    session._queueBound = true;
  }

  return session;
}

async function playNextQueuedTrack(guildId, client, channelId) {
  const queue = getGuildQueue(guildId);
  if (!queue.length) {
    return { ok: false, status: "empty" };
  }

  const next = queue[0];
  guildQueues.set(guildId, queue.slice(1));

  const session = guildPlayers.get(guildId) || (await ensureGuildPlayer(client, guildId, channelId));
  const resource = await createResourceFromUrl(next.url);
  session.player.play(resource);
  session.lastTrack = { title: next.title, url: next.url };

  return {
    ok: true,
    status: "playing",
    title: next.title,
    url: next.url,
  };
}

async function playGuildMusic({ client, guildId, channelId, query }) {
  const normalized = normalizeMediaQuery(query);
  if (!normalized) {
    return { ok: false, status: "error", reason: "EMPTY_QUERY" };
  }

  try {
    const source = await resolveTrackSource(normalized);
    const session = guildPlayers.get(guildId);

    if (session && session.player && session.player.state && session.player.state.status !== "idle") {
      const queued = enqueueGuildTrack(guildId, {
        title: source.title,
        url: source.url,
      });
      return {
        ok: queued.ok,
        status: queued.ok ? "queued" : "error",
        title: source.title,
        url: source.url,
        queueLength: queued.queueLength || getGuildQueue(guildId).length,
      };
    }

    const activeSession = await ensureGuildPlayer(client, guildId, channelId);
    const resource = await createResourceFromUrl(source.url);
    activeSession.player.play(resource);
    activeSession.lastTrack = {
      title: source.title,
      url: source.url,
    };

    return {
      ok: true,
      status: "playing",
      title: source.title,
      url: source.url,
    };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      reason: err?.message || "PLAY_FAILED",
    };
  }
}

function getGuildQueue(guildId) {
  const queue = guildQueues.get(guildId);
  return Array.isArray(queue) ? queue.slice() : [];
}

async function advanceGuildQueue(guildId) {
  const queue = getGuildQueue(guildId);
  if (!queue.length) {
    return { ok: false, status: "empty" };
  }

  const next = queue[1] || null;
  guildQueues.set(guildId, next ? queue.slice(1) : []);
  return {
    ok: true,
    status: "advanced",
    nextTitle: next ? next.title : null,
    queueLength: next ? getGuildQueue(guildId).length : 0,
  };
}

async function clearGuildQueue(guildId) {
  const queue = getGuildQueue(guildId);
  if (!queue.length) {
    return { ok: true, status: "empty", cleared: 0 };
  }

  guildQueues.delete(guildId);
  return {
    ok: true,
    status: "cleared",
    cleared: queue.length,
  };
}

function enqueueGuildTrack(guildId, track) {
  if (!guildId || !track) {
    return { ok: false, status: "error", reason: "INVALID_TRACK" };
  }

  const title = String(track.title || track.url || "").trim();
  const url = String(track.url || track.title || "").trim();
  if (!title || !url) {
    return { ok: false, status: "error", reason: "INVALID_TRACK" };
  }

  const queue = getGuildQueue(guildId);
  const item = { title, url };
  queue.push(item);
  guildQueues.set(guildId, queue);

  return {
    ok: true,
    status: "queued",
    queueLength: queue.length,
    item,
  };
}

function getNowPlaying(guildId) {
  const session = guildPlayers.get(guildId);
  if (session?.lastTrack) {
    return session.lastTrack;
  }

  const queue = getGuildQueue(guildId);
  return queue[0] || null;
}

async function stopGuildMusic(guildId) {
  const session = guildPlayers.get(guildId);
  if (!session) {
    guildQueues.delete(guildId);
    return { ok: true, status: "stopped" };
  }

  try {
    session.player?.stop();
  } catch {}

  try {
    session.connection?.destroy();
  } catch {}

  guildPlayers.delete(guildId);
  guildQueues.delete(guildId);
  return { ok: true, status: "stopped" };
}

async function leaveGuildMusic(guildId) {
  return stopGuildMusic(guildId);
}

async function pauseGuildMusic(guildId) {
  const session = guildPlayers.get(guildId);
  if (!session || !session.player) {
    return { ok: false, status: "idle" };
  }

  try {
    session.player.pause();
    session.player.state = { ...session.player.state, status: "paused" };
    return { ok: true, status: "paused" };
  } catch (err) {
    return { ok: false, status: "error", reason: err?.message || "PAUSE_FAILED" };
  }
}

async function resumeGuildMusic(guildId) {
  const session = guildPlayers.get(guildId);
  if (!session || !session.player) {
    return { ok: false, status: "idle" };
  }

  try {
    if (typeof session.player.unpause === "function") {
      session.player.unpause();
    }
    session.player.state = { ...session.player.state, status: "playing" };
    return { ok: true, status: "playing" };
  } catch (err) {
    return { ok: false, status: "error", reason: err?.message || "RESUME_FAILED" };
  }
}

async function skipGuildMusic(guildId) {
  const session = guildPlayers.get(guildId);
  if (!session) {
    const hasQueue = getGuildQueue(guildId).length > 0;
    if (hasQueue) {
      guildQueues.delete(guildId);
      return { ok: true, status: "skipped" };
    }
    return { ok: false, status: "idle" };
  }

  try {
    const queue = getGuildQueue(guildId);
    if (queue.length > 0) {
      const next = queue[0];
      guildQueues.set(guildId, queue.slice(1));
      const resource = await createResourceFromUrl(next.url).catch(() => null);
      if (resource) {
        session.player?.stop();
        session.player?.play(resource);
        session.lastTrack = { title: next.title, url: next.url };
        return { ok: true, status: "skipped", title: next.title };
      }
    }

    session.player?.stop();
    return { ok: true, status: "skipped" };
  } catch (err) {
    return { ok: false, status: "error", reason: err?.message || "SKIP_FAILED" };
  } finally {
    try {
      const queue = getGuildQueue(guildId);
      if (!queue.length && session && session.connection) {
        session.connection.destroy();
        guildPlayers.delete(guildId);
      }
    } catch {}
  }
}

function getGuildMusicState(guildId) {
  const session = guildPlayers.get(guildId);
  if (!session) {
    return { ok: false, status: "stopped" };
  }

  return {
    ok: true,
    status: session.player?.state?.status || "playing",
    title: session.lastTrack?.title || null,
    channelId: session.channelId || null,
  };
}

module.exports = {
  normalizeMediaQuery,
  isPlayableUrl,
  resolveTrackSource,
  playGuildMusic,
  stopGuildMusic,
  leaveGuildMusic,
  pauseGuildMusic,
  resumeGuildMusic,
  skipGuildMusic,
  enqueueGuildTrack,
  advanceGuildQueue,
  clearGuildQueue,
  getGuildQueue,
  getNowPlaying,
  getGuildMusicState,
  guildPlayers,
  guildQueues,
};
