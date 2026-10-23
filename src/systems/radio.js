const { Readable } = require("stream");
const { getFeature } = require("./featuresService");
const status = require("./status");

const voiceLib = (() => {
  try {
    return require("@discordjs/voice");
  } catch {
    return null;
  }
})();

const playDl = (() => {
  try {
    return require("play-dl");
  } catch {
    return null;
  }
})();

const RADIO_DEFAULTS = {
  enabled: false,
  voiceChannelId: null,
  streamUrl: null,
  streamType: "mp3",
  reconnectMinutes: 15,
  statusMessage: null,
};

const radioSessions = new Map();
let scheduler = null;

function normalizeRadioConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const enabled = src.enabled === true || src.enabled === "true";
  const reconnectMinutes = Number.isFinite(Number(src.reconnectMinutes))
    ? Math.min(1440, Math.max(1, Number(src.reconnectMinutes)))
    : RADIO_DEFAULTS.reconnectMinutes;

  return {
    enabled,
    voiceChannelId:
      src.voiceChannelId === null || src.voiceChannelId === undefined
        ? null
        : String(src.voiceChannelId).trim() || null,
    streamUrl:
      src.streamUrl === null || src.streamUrl === undefined
        ? null
        : String(src.streamUrl).trim() || null,
    streamType:
      src.streamType === "hls" || src.streamType === "mp3"
        ? src.streamType
        : RADIO_DEFAULTS.streamType,
    reconnectMinutes,
    statusMessage:
      src.statusMessage === null || src.statusMessage === undefined
        ? null
        : String(src.statusMessage).trim() || null,
  };
}

function buildRadioStatus(overrides = {}) {
  return {
    status: "offline",
    ...RADIO_DEFAULTS,
    ...normalizeRadioConfig(overrides),
  };
}

async function getRadioRuntimeStatus({ client, guildId, config } = {}) {
  if (!guildId || !client || !config || !config.enabled) {
    return buildRadioStatus({ enabled: false });
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  const voiceOk = guild && config.voiceChannelId
    ? Boolean(guild.channels.cache.get(config.voiceChannelId)) ||
      Boolean(await guild.channels.fetch(config.voiceChannelId).catch(() => null))
    : false;

  return buildRadioStatus({
    ...config,
    enabled: Boolean(config.enabled),
    statusMessage: voiceOk
      ? config.statusMessage || "ready"
      : "voice channel pending",
  });
}

function stopRadioSession(guildId) {
  const session = radioSessions.get(guildId);
  if (!session) return;

  try {
    session.player?.stop();
  } catch {}
  try {
    session.connection?.destroy();
  } catch {}
  radioSessions.delete(guildId);
}

function getAudioResourceFromUrl(url, streamType) {
  if (!voiceLib) {
    throw new Error("@discordjs/voice is not installed");
  }

  return (async () => {
    const urlValue = String(url || "").trim();
    if (!urlValue) {
      throw new Error("Radio URL is blank");
    }

    if (playDl && typeof playDl.stream === "function") {
      try {
        const data = await playDl.stream(urlValue, {
          quality: 0,
          discordPlayerCompatibility: true,
        });
        const stream = data && (data.stream || data);
        if (stream) {
          const chosenType = data && data.type ? data.type : voiceLib.StreamType.Arbitrary;
          return voiceLib.createAudioResource(stream, {
            inputType: chosenType,
            inlineVolume: true,
          });
        }
      } catch (err) {
        console.warn("[Radio] play-dl fallback failed, retrying with raw HTTP stream:", err?.message || err);
      }
    }

    const response = await fetch(urlValue);
    if (!response.ok || !response.body) {
      throw new Error(`Radio URL returned HTTP ${response.status}`);
    }

    const nodeStream = Readable.fromWeb(response.body);
    return voiceLib.createAudioResource(nodeStream, {
      inputType:
        streamType === "hls" ? voiceLib.StreamType.Arbitrary : voiceLib.StreamType.Arbitrary,
      inlineVolume: true,
    });
  })();
}

async function ensureRadioSession(client, guild, config) {
  if (!client || !guild || !config || config.enabled !== true) {
    stopRadioSession(guild && guild.id);
    return null;
  }
  if (!config.voiceChannelId || !config.streamUrl) {
    stopRadioSession(guild.id);
    return null;
  }

  const guildId = guild.id;
  const existing = radioSessions.get(guildId);
  if (
    existing &&
    existing.channelId === config.voiceChannelId &&
    existing.connection &&
    existing.connection.state.status !== "destroyed"
  ) {
    return existing;
  }

  stopRadioSession(guildId);

  const connection = voiceLib.joinVoiceChannel({
    channelId: config.voiceChannelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  const player = voiceLib.createAudioPlayer({
    behaviors: { noSubscriber: voiceLib.NoSubscriberBehavior.Pause },
  });

  connection.subscribe(player);

  try {
    const resource = await getAudioResourceFromUrl(
      config.streamUrl,
      config.streamType,
    );
    player.play(resource);
  } catch (err) {
    console.warn(
      `[Radio] Failed to start stream for guild "${guild.name || guildId}":`,
      err?.message || err,
    );
    connection.destroy();
    return null;
  }

  const session = {
    guildId,
    channelId: config.voiceChannelId,
    connection,
    player,
    reconnectMinutes: config.reconnectMinutes,
    status: "playing",
    lastStartedAt: Date.now(),
  };

  player.on("stateChange", (oldState, newState) => {
    if (newState.status === "idle" && oldState.status !== "idle") {
      session.status = "reconnecting";
      setTimeout(() => {
        if (radioSessions.get(guildId) === session) {
          ensureRadioSession(client, guild, config).catch(() => null);
        }
      }, Math.max(1, Number(config.reconnectMinutes || 15)) * 60_000).unref?.();
    }
  });

  player.on("error", (err) => {
    console.warn(
      `[Radio] Playback error for guild "${guild.name || guildId}":`,
      err?.message || err,
    );
    session.status = "error";
    setTimeout(() => {
      if (radioSessions.get(guildId) === session) {
        ensureRadioSession(client, guild, config).catch(() => null);
      }
    }, Math.max(1, Number(config.reconnectMinutes || 15)) * 60_000).unref?.();
  });

  connection.on("stateChange", (_, newState) => {
    if (newState.status === "disconnected") {
      session.status = "reconnecting";
    }
  });

  radioSessions.set(guildId, session);
  return session;
}

async function checkGuild(client, guild) {
  const config = normalizeRadioConfig(
    await getFeature(guild.id, "radio").catch(() => null),
  );

  if (!config.enabled || !config.voiceChannelId || !config.streamUrl) {
    stopRadioSession(guild.id);
    return false;
  }

  const channel = await client.channels.fetch(config.voiceChannelId).catch(() => null);
  if (!channel || channel.guildId !== guild.id) {
    stopRadioSession(guild.id);
    return false;
  }

  await ensureRadioSession(client, guild, config);
  return true;
}

async function tick(client) {
  const guilds = client && client.guilds && client.guilds.cache;
  if (!guilds) return;

  for (const guild of guilds.values()) {
    try {
      await checkGuild(client, guild);
    } catch (err) {
      console.warn(
        `[Radio] Scheduler failed for "${guild.name || guild.id}":`,
        err?.message || err,
      );
    }
  }
}

async function startGuildRadio(client, guildId) {
  if (!client || !guildId) {
    return { ok: false, status: "offline", reason: "CLIENT_OR_GUILD_REQUIRED" };
  }

  let guild = null;
  if (
    client.guilds &&
    client.guilds.cache &&
    client.guilds.cache.get(guildId)
  ) {
    guild = client.guilds.cache.get(guildId);
  } else if (client.guilds && typeof client.guilds.fetch === "function") {
    guild = await client.guilds.fetch(guildId).catch(() => null);
  }

  if (!guild) {
    return { ok: false, status: "offline", reason: "GUILD_NOT_FOUND" };
  }

  const config = normalizeRadioConfig(
    await getFeature(guild.id, "radio").catch(() => null),
  );
  if (!config.enabled || !config.voiceChannelId || !config.streamUrl) {
    stopRadioSession(guild.id);
    return { ok: false, status: "offline", reason: "RADIO_CONFIG_INCOMPLETE" };
  }

  const session = await ensureRadioSession(client, guild, config);
  const nextStatus = session ? session.status || "playing" : "offline";
  if (status && typeof status.setRadioRunning === "function") {
    status.setRadioRunning(Boolean(session));
  }
  return {
    ok: Boolean(session),
    status: nextStatus,
    reason: session ? null : "RADIO_SESSION_FAILED",
  };
}

async function stopGuildRadio(guildId) {
  if (!guildId) {
    return { ok: false, status: "offline", reason: "GUILD_ID_REQUIRED" };
  }

  stopRadioSession(guildId);
  if (status && typeof status.setRadioRunning === "function") {
    status.setRadioRunning(false);
  }

  return { ok: true, status: "offline" };
}

function startRadio(client) {
  if (!voiceLib) {
    console.warn("[Radio] @discordjs/voice is not installed; radio will stay disabled.");
    if (status && typeof status.setRadioRunning === "function") {
      status.setRadioRunning(false);
    }
    return { client, tick: () => Promise.resolve() };
  }

  if (scheduler) {
    if (status && typeof status.setRadioRunning === "function") {
      status.setRadioRunning(true);
    }
    return { client, tick: () => tick(client) };
  }

  const run = () =>
    tick(client).catch((err) =>
      console.error("[Radio] Scheduler tick failed:", err),
    );

  setTimeout(run, 10_000).unref?.();
  scheduler = setInterval(run, 30_000);
  scheduler.unref?.();
  if (status && typeof status.setRadioRunning === "function") {
    status.setRadioRunning(true);
  }
  return { client, tick: () => tick(client) };
}

module.exports = {
  RADIO_DEFAULTS,
  normalizeRadioConfig,
  buildRadioStatus,
  getRadioRuntimeStatus,
  startGuildRadio,
  stopGuildRadio,
  startRadio,
  tick,
  checkGuild,
  stopRadioSession,
  radioSessions,
};
