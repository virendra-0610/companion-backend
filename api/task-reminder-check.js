import { requireCronSecret } from "../lib/auth.js";
import { checkTaskReminders } from "../lib/taskReminders.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";
  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true" || req.query.dryRun === "1";
  const limit = Number(req.query.limit || 100);

  try {
    const result = await checkTaskReminders({
      force,
      dryRun,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100
    });

    return res.status(200).json({
      ok: true,
      mode: "task-reminder-check",
      force,
      dryRun,
      ...result
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
