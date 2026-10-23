const { normalizeFeature } = require("../../systems/featuresService");
const {
  normalizeRadioConfig,
  buildRadioStatus,
  getRadioRuntimeStatus,
  startGuildRadio,
  stopGuildRadio,
} = require("../../systems/radio");

function registerRadioRoutes({
  app,
  requireDashboardAuth,
  requirePerm,
  requireGuildAccess,
  sanitizeId,
  getClient,
  GuildConfig,
  rateLimit,
  recordAudit,
  getActorFromRequest,
  requirePremium,
}) {
  const guardGuildQuery =
    typeof requireGuildAccess === "function"
      ? requireGuildAccess({ from: "query", key: "guildId" })
      : (req, res, next) => next();

  const guardGuildBody =
    typeof requireGuildAccess === "function"
      ? requireGuildAccess({ from: "body", key: "guildId" })
      : (req, res, next) => next();

  const canViewConfig =
    typeof requirePerm === "function"
      ? requirePerm({ anyOf: ["canViewConfig", "canEditConfig"] })
      : (req, res, next) => next();

  const canEditConfig =
    typeof requirePerm === "function"
      ? requirePerm({ anyOf: ["canEditConfig"] })
      : (req, res, next) => next();

  const premiumGuard =
    typeof requirePremium === "function"
      ? requirePremium({ from: "body", key: "guildId" })
      : (req, res, next) => next();

  app.get(
    "/api/radio",
    requireDashboardAuth,
    canViewConfig,
    guardGuildQuery,
    async (req, res) => {
      try {
        const guildId = sanitizeId(req.query.guildId || "");
        if (!guildId) {
          return res.status(400).json({ ok: false, error: "GUILD_ID_REQUIRED" });
        }
        if (!GuildConfig) {
          return res.status(503).json({ ok: false, error: "GUILD_CONFIG_MODEL_MISSING" });
        }

        const stored = await GuildConfig.findOne({ guildId }).lean();
        const value = normalizeFeature(
          "radio",
          stored && stored.features && stored.features.radio,
        );
        const client = typeof getClient === "function" ? getClient() : null;
        const runtime = client
          ? await getRadioRuntimeStatus({
              client,
              guildId,
              config: value,
            })
          : buildRadioStatus({ enabled: value.enabled === true });

        return res.json({
          ok: true,
          value: {
            ...value,
            status: runtime && runtime.status ? runtime.status : "offline",
            statusMessage:
              runtime && runtime.statusMessage
                ? runtime.statusMessage
                : value.statusMessage || null,
          },
        });
      } catch (err) {
        console.error("[Dashboard] /api/radio GET error:", err);
        return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
      }
    },
  );

  app.post(
    "/api/radio",
    requireDashboardAuth,
    canEditConfig,
    guardGuildBody,
    premiumGuard,
    async (req, res) => {
      try {
        const guildId = sanitizeId(req.body.guildId || "");
        if (!guildId) {
          return res.status(400).json({ ok: false, error: "GUILD_ID_REQUIRED" });
        }
        if (!GuildConfig) {
          return res.status(503).json({ ok: false, error: "GUILD_CONFIG_MODEL_MISSING" });
        }

        const raw = req.body && typeof req.body === "object" ? req.body : {};
        const value = normalizeRadioConfig(raw.value || raw);

        await GuildConfig.findOneAndUpdate(
          { guildId },
          { $set: { "features.radio": value } },
          { upsert: true, returnDocument: "after" },
        ).lean();

        if (typeof recordAudit === "function") {
          await recordAudit({
            req,
            action: "radio.update",
            guildId,
            actor:
              typeof getActorFromRequest === "function"
                ? getActorFromRequest(req)
                : null,
            payload: { enabled: value.enabled },
          });
        }

        return res.json({ ok: true, value });
      } catch (err) {
        console.error("[Dashboard] /api/radio POST error:", err);
        return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
      }
    },
  );

  app.post(
    "/api/radio/start",
    requireDashboardAuth,
    canEditConfig,
    guardGuildBody,
    premiumGuard,
    async (req, res) => {
      try {
        const guildId = sanitizeId(req.body.guildId || "");
        if (!guildId) {
          return res.status(400).json({ ok: false, error: "GUILD_ID_REQUIRED" });
        }

        const client = typeof getClient === "function" ? getClient() : null;
        const result = await startGuildRadio(client, guildId);

        if (typeof recordAudit === "function") {
          await recordAudit({
            req,
            action: result.ok ? "radio.start" : "radio.start_failed",
            guildId,
            actor:
              typeof getActorFromRequest === "function"
                ? getActorFromRequest(req)
                : null,
            payload: { ok: result.ok, status: result.status, reason: result.reason || null },
          });
        }

        return res.json({ ok: result.ok, status: result.status, reason: result.reason || null });
      } catch (err) {
        console.error("[Dashboard] /api/radio/start error:", err);
        return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
      }
    },
  );

  app.post(
    "/api/radio/stop",
    requireDashboardAuth,
    canEditConfig,
    guardGuildBody,
    premiumGuard,
    async (req, res) => {
      try {
        const guildId = sanitizeId(req.body.guildId || "");
        if (!guildId) {
          return res.status(400).json({ ok: false, error: "GUILD_ID_REQUIRED" });
        }

        const result = await stopGuildRadio(guildId);

        if (typeof recordAudit === "function") {
          await recordAudit({
            req,
            action: result.ok ? "radio.stop" : "radio.stop_failed",
            guildId,
            actor:
              typeof getActorFromRequest === "function"
                ? getActorFromRequest(req)
                : null,
            payload: { ok: result.ok, status: result.status, reason: result.reason || null },
          });
        }

        return res.json({ ok: result.ok, status: result.status, reason: result.reason || null });
      } catch (err) {
        console.error("[Dashboard] /api/radio/stop error:", err);
        return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
      }
    },
  );
}

module.exports = { registerRadioRoutes };
