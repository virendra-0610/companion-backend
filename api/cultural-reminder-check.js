import { requireCronSecret } from "../lib/auth.js";
import { getNotificationTokens, TOKEN_POLICY } from "../lib/push.js";
import { checkCulturalReminders } from "../lib/culturalReminders.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";
  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true" || req.query.dryRun === "1";
  const includeTips = String(req.query.tips || "").toLowerCase() === "true" || req.query.tips === "1";
  const date = String(req.query.date || "").trim();
  const timeZone = String(req.query.timeZone || process.env.DEFAULT_TIME_ZONE || "Asia/Kolkata").trim();
  const countryCode = String(req.query.countryCode || req.query.country || "").trim();

  try {
    const tokens = await getNotificationTokens();

    if (tokens.length === 0) {
      return res.status(200).json({
        ok: true,
        mode: "cultural-reminder-check",
        sent: 0,
        message: "No notification tokens found"
      });
    }

    const result = await checkCulturalReminders({
      tokens,
      force,
      dryRun,
      includeTips,
      date,
      timeZone,
      countryCode
    });

    return res.status(200).json({
      ok: true,
      mode: "cultural-reminder-check",
      tokenPolicy: TOKEN_POLICY,
      ...result
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
