import { requireCronSecret } from "../lib/auth.js";
import { checkTaskReminders } from "../lib/taskReminders.js";
import { checkPersonalEventReminders } from "../lib/personalEventReminders.js";
import { TOKEN_POLICY } from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";
  const dryRun = String(req.query.dryRun || "").toLowerCase() === "true" || req.query.dryRun === "1";
  const cleanupExpired = String(req.query.cleanupExpired || req.query.cleanup || "").toLowerCase() === "true" || req.query.cleanupExpired === "1" || req.query.cleanup === "1";
  const limit = Number(req.query.limit || 200);
  const taskId = String(req.query.taskId || "").trim();
  const eventId = String(req.query.eventId || "").trim();
  const timeZone = String(req.query.timeZone || req.query.tz || "").trim();
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;

  try {
    const [tasks, personalEvents] = await Promise.all([
      checkTaskReminders({ force, dryRun, cleanupExpired, limit: safeLimit, taskId, timeZone }),
      checkPersonalEventReminders({ force, dryRun, limit: safeLimit, eventId, timeZone })
    ]);

    return res.status(200).json({
      ok: true,
      mode: "unified-reminder-check",
      version: "v14-personal-events",
      tokenPolicy: TOKEN_POLICY,
      force,
      dryRun,
      cleanupExpired,
      taskId: taskId || null,
      eventId: eventId || null,
      timeZone: timeZone || null,
      summary: {
        scanned: (tasks.scanned || 0) + (personalEvents.scanned || 0),
        sent: (tasks.sent || 0) + (personalEvents.sent || 0),
        skipped: (tasks.skipped || 0) + (personalEvents.skipped || 0),
        failed: (tasks.failed || 0) + (personalEvents.failed || 0)
      },
      tasks,
      personalEvents
    });
  } catch (error) {
    // Always return HTTP 200 to scheduler calls so cron-job.org does not disable the job.
    return res.status(200).json({
      ok: false,
      mode: "unified-reminder-check",
      version: "v14-personal-events",
      tokenPolicy: TOKEN_POLICY,
      error: error.message || String(error),
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined
    });
  }
}
