const { test, eq } = require("./_harness");
const {
  FEATURE_DEFAULTS,
  normalizeFeature,
} = require("../../src/systems/featuresService");
const { resolveGuildAntiSpamConfig } = require("../../src/systems/antiSpam");
const {
  applyPatch,
  getValue,
} = require("../../src/systems/configManager");
const {
  diagnoseFeature,
} = require("../../src/dashboard/routes/features");
const gameNewsSystem = require("../../src/systems/gamenews");

test("serverStats keeps all metrics enabled for existing guild configs", () => {
  const feature = normalizeFeature("serverStats", { enabled: true });
  eq(feature.showMembers, true);
  eq(feature.showJoins, true);
  eq(feature.showLeaves, true);
});

test("serverStats preserves independently disabled metrics", () => {
  const feature = normalizeFeature("serverStats", {
    showMembers: true,
    showJoins: false,
    showLeaves: false,
  });
  eq(feature.showMembers, true);
  eq(feature.showJoins, false);
  eq(feature.showLeaves, false);
});

test("antiSpam is disabled until configured for a guild", () => {
  const feature = normalizeFeature("antiSpam", null);
  eq(feature.enabled, false);
  eq(feature.maxMessages, 5);
  eq(feature.intervalSeconds, 10);
});

test("antiSpam normalizes guild overrides and converts units at runtime", () => {
  const feature = normalizeFeature("antiSpam", {
    enabled: true,
    maxMessages: 4,
    intervalSeconds: 20,
    muteDurationMinutes: 8,
    actionCooldownSeconds: 30,
    softActionsEnabled: false,
    strikeWindowSeconds: 90,
    strikesToMute: 3,
    minLength: 4,
    similarityThreshold: 0.9,
    ignoreAttachments: false,
    bypassAdmins: true,
    sendMessage: false,
  });
  const runtime = resolveGuildAntiSpamConfig(feature);

  eq(runtime.enabled, true);
  eq(runtime.maxMessages, 4);
  eq(runtime.interval, 20_000);
  eq(runtime.muteDuration, 8 * 60_000);
  eq(runtime.actionCooldown, 30_000);
  eq(runtime.softActions.enabled, false);
  eq(runtime.softActions.strikeWindowMs, 90_000);
  eq(runtime.softActions.strikesToMute, 3);
  eq(Object.keys(runtime.channels).length, 0);
  eq(runtime.bypassRoles.length, 0);
});

test("antiSpam defaults are independent of global activation", () => {
  eq(FEATURE_DEFAULTS.antiSpam.enabled, false);
  eq(FEATURE_DEFAULTS.antiSpam.similarityThreshold, 0.85);
});

test("runtime config accepts dashboard-style antiSpam aliases", () => {
  const res = applyPatch({
    patches: [
      { path: "antiSpam.intervalSeconds", value: 20 },
      { path: "antiSpam.muteDurationMinutes", value: 8 },
      { path: "antiSpam.actionCooldownSeconds", value: 30 },
      { path: "antiSpam.softActionsEnabled", value: false },
      { path: "antiSpam.strikeWindowSeconds", value: 90 },
      { path: "antiSpam.strikesToMute", value: 3 },
    ],
  });

  eq(res.ok, true);
  eq(res.applied.includes("antiSpam.intervalSeconds"), true);
  eq(getValue("antiSpam.interval"), 20_000);
  eq(getValue("antiSpam.muteDuration"), 8 * 60_000);
  eq(getValue("antiSpam.actionCooldown"), 30_000);
  eq(getValue("antiSpam.softActions.enabled"), false);
  eq(getValue("antiSpam.softActions.strikeWindowMs"), 90_000);
  eq(getValue("antiSpam.softActions.strikesToMute"), 3);
});

test("feature diagnosis flags missing channel setup for memes", async () => {
  const diagnosis = await diagnoseFeature({
    client: { channels: { fetch: async () => null } },
    guild: {
      id: "guild-1",
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map() },
    },
    feature: "memes",
    config: { enabled: true, channelId: null, intervalMinutes: 60 },
  });

  eq(diagnosis.status, "incomplete");
  eq(diagnosis.issues.some((issue) => issue.code === "missing_channel"), true);
});

test("feature diagnosis flags incomplete serverStats setup", async () => {
  const diagnosis = await diagnoseFeature({
    client: { channels: { fetch: async () => null } },
    guild: {
      id: "guild-1",
      members: { me: { permissions: { has: () => true } } },
      roles: { cache: new Map() },
    },
    feature: "serverStats",
    config: { enabled: true, showMembers: false, showJoins: false, showLeaves: false },
  });

  eq(diagnosis.status, "incomplete");
  eq(diagnosis.issues.some((issue) => issue.code === "missing_stats_metric"), true);
});

test("gameNews accepts a one-minute global interval in milliseconds", () => {
  const res = applyPatch({
    patches: [{ path: "gameNews.interval", value: 60 * 1000 }],
  });

  eq(res.ok, true);
  eq(res.applied.includes("gameNews.interval"), true);
});

test("gameNews scheduler respects the shortest active feed interval", () => {
  const interval = gameNewsSystem._internals.computeGameNewsPollInterval(
    { gameNews: { interval: 30 * 60 * 1000 } },
    [{ intervalMs: 60 * 1000 }, { intervalMs: 5 * 60 * 1000 }],
  );

  eq(interval, 60 * 1000);
});

test("antiSpam partial overrides retain local defaults without activation", () => {
  const feature = normalizeFeature("antiSpam", {
    maxMessages: 7,
    enabled: null,
    similarityThreshold: null,
  });

  eq(feature.enabled, false);
  eq(feature.maxMessages, 7);
  eq(feature.similarityThreshold, 0.85);
});

test("autoModeration is disabled with no inherited global word lists", () => {
  const feature = normalizeFeature("autoModeration", null);
  eq(feature.enabled, false);
  eq(feature.maxWarnings, 3);
  eq(feature.muteDurationMinutes, 10);
  eq(feature.bannedWordsPt, "");
  eq(feature.bannedWordsEn, "");
});
