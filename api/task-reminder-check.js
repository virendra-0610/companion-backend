import { requireCronSecret } from "../lib/auth.js";
import { checkTaskReminders } from "../lib/taskReminders.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";
  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true" || req.query.dryRun === "1";
  const limit = Number(req.query.limit || 200);
  const taskId = String(req.query.taskId || "").trim();
  const timeZone = String(req.query.timeZone || req.query.tz || "").trim();

  try {
    const result = await checkTaskReminders({
      force,
      dryRun,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200,
      taskId,
      timeZone
    });

    return res.status(200).json({
      ok: true,
      mode: "task-reminder-check",
      version: "v10-cron-hardening",
      force,
      dryRun,
      taskId: taskId || null,
      timeZone: timeZone || null,
      ...result
    });
  } catch (error) {
    // Important: return HTTP 200 for scheduler calls so cron-job.org does not disable
    // the job again. The JSON still clearly exposes ok:false and the error.
    return res.status(200).json({
      ok: false,
      mode: "task-reminder-check",
      version: "v10-cron-hardening",
      error: error.message || String(error),
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
}
