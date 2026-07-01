import { getFirestore } from "./firebaseAdmin.js";
import { sendPushToToken, removeBadToken } from "./push.js";

const TASK_COLLECTION = "todo_tasks";
const TOKEN_COLLECTION = "notification_tokens";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function checkTaskReminders({
  force = false,
  dryRun = false,
  limit = 100,
  taskId = "",
  timeZone = ""
} = {}) {
  const db = getFirestore();
  const now = new Date();

  const docs = await loadCandidateTasks(db, { limit, taskId });

  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    const task = doc.data() || {};
    const effectiveTaskId = doc.id;
    const dueAt = toDate(task.dueAt);

    if (!dueAt) {
      skipped += 1;
      results.push({ taskId: effectiveTaskId, ok: true, skipped: true, reason: "Missing dueAt" });
      continue;
    }

    const tokenResolution = await resolveTaskToken(db, task);
    const effectiveTimeZone = resolveTimeZone({
      explicitTimeZone: timeZone,
      task,
      tokenData: tokenResolution.tokenData
    });

    const reminder = force
      ? buildForcedReminder(task, dueAt, effectiveTimeZone)
      : chooseReminder(task, dueAt, now);

    if (!reminder) {
      skipped += 1;
      results.push({
        taskId: effectiveTaskId,
        ok: true,
        skipped: true,
        title: task.title || "Untitled task",
        dueAtUtc: dueAt.toISOString(),
        dueAtLocal: formatDateTime(dueAt, effectiveTimeZone),
        timeZone: effectiveTimeZone,
        reason: "No reminder due"
      });
      continue;
    }

    if (!tokenResolution.token) {
      skipped += 1;
      await markTaskError(doc.ref, `Missing FCM token for task ${effectiveTaskId}`);
      results.push({ taskId: effectiveTaskId, ok: false, skipped: true, reason: "Missing FCM token" });
      continue;
    }

    if (!force && tokenResolution.taskRemindersEnabled === false) {
      skipped += 1;
      results.push({ taskId: effectiveTaskId, ok: true, skipped: true, reason: "Task reminders disabled" });
      continue;
    }

    const title = reminder.title;
    const body = reminder.body;

    if (dryRun) {
      skipped += 1;
      results.push({
        taskId: effectiveTaskId,
        ok: true,
        dryRun: true,
        reminderType: reminder.type,
        title,
        body,
        dueAtUtc: dueAt.toISOString(),
        dueAtLocal: formatDateTime(dueAt, effectiveTimeZone),
        timeZone: effectiveTimeZone,
        tokenSource: tokenResolution.source,
        tokenDocId: tokenResolution.tokenDocId || null,
        tokenTail: tokenResolution.token ? tokenResolution.token.slice(-8) : null
      });
      continue;
    }

    try {
      const messageId = await sendPushToToken({
        token: tokenResolution.token,
        title,
        body,
        data: {
          type: "task_reminder",
          reminderType: reminder.type,
          taskId: effectiveTaskId,
          dueAt: dueAt.toISOString(),
          dueAtLocal: formatDateTime(dueAt, effectiveTimeZone),
          timeZone: effectiveTimeZone,
          force: force ? "true" : "false"
        }
      });

      if (!force) {
        await markReminderSent(doc.ref, reminder.type);
      } else {
        await markForcedTest(doc.ref, reminder.type);
      }

      sent += 1;
      results.push({
        taskId: effectiveTaskId,
        ok: true,
        reminderType: reminder.type,
        messageId,
        dueAtUtc: dueAt.toISOString(),
        dueAtLocal: formatDateTime(dueAt, effectiveTimeZone),
        timeZone: effectiveTimeZone,
        tokenSource: tokenResolution.source,
        tokenDocId: tokenResolution.tokenDocId || null,
        tokenTail: tokenResolution.token ? tokenResolution.token.slice(-8) : null
      });
    } catch (error) {
      failed += 1;
      const msg = error.message || String(error);
      await markTaskError(doc.ref, msg);

      if (
        tokenResolution.tokenDocId &&
        (msg.includes("registration-token-not-registered") || msg.includes("invalid-registration-token"))
      ) {
        await removeBadToken(tokenResolution.tokenDocId);
      }

      results.push({ taskId: effectiveTaskId, ok: false, reminderType: reminder.type, error: msg });
    }
  }

  return {
    nowUtc: now.toISOString(),
    nowLocal: formatDateTime(now, timeZone || process.env.DEFAULT_TIME_ZONE || "Asia/Kolkata"),
    requestedTaskId: taskId || null,
    scanned: docs.length,
    sent,
    skipped,
    failed,
    results
  };
}

async function loadCandidateTasks(db, { limit, taskId }) {
  const cleanTaskId = String(taskId || "").trim();

  if (cleanTaskId) {
    const directSnap = await db.collection(TASK_COLLECTION).doc(cleanTaskId).get();
    if (directSnap.exists) return [directSnap];

    const byIdSnap = await db
      .collection(TASK_COLLECTION)
      .where("id", "==", cleanTaskId)
      .limit(1)
      .get();

    return byIdSnap.docs;
  }

  const snap = await db
    .collection(TASK_COLLECTION)
    .where("completed", "==", false)
    .where("deleted", "==", false)
    .limit(limit)
    .get();

  return snap.docs;
}

function chooseReminder(task, dueAt, now) {
  const dueMs = dueAt.getTime();
  const nowMs = now.getTime();
  const untilDueMs = dueMs - nowMs;

  if (!task.reminderDueSent && dueMs <= nowMs && dueMs >= nowMs - TEN_MINUTES_MS) {
    return {
      type: "due",
      flag: "reminderDueSent",
      title: "Task due now",
      body: `${safeTitle(task.title)} is due now.`
    };
  }

  if (!task.reminder30MinSent && untilDueMs > 0 && untilDueMs <= THIRTY_MINUTES_MS) {
    return {
      type: "30min",
      flag: "reminder30MinSent",
      title: "Task reminder",
      body: `${safeTitle(task.title)} is due in about ${formatMinutes(untilDueMs)}.`
    };
  }

  const oneDayReminderAt = dueMs - ONE_DAY_MS;
  const oneDayWindowStart = nowMs - FIVE_MINUTES_MS;
  const oneDayWindowEnd = nowMs + FIVE_MINUTES_MS;

  if (
    !task.reminder1DaySent &&
    oneDayReminderAt >= oneDayWindowStart &&
    oneDayReminderAt <= oneDayWindowEnd &&
    untilDueMs > THIRTY_MINUTES_MS
  ) {
    return {
      type: "1day",
      flag: "reminder1DaySent",
      title: "Task reminder for tomorrow",
      body: `${safeTitle(task.title)} is due tomorrow.`
    };
  }

  return null;
}

function buildForcedReminder(task, dueAt, timeZone) {
  return {
    type: "forced_task_test",
    flag: null,
    title: "Task reminder test",
    body: `${safeTitle(task.title)} is scheduled for ${formatDateTime(dueAt, timeZone)}.`
  };
}

async function resolveTaskToken(db, task) {
  const tokenDocId = typeof task.tokenDocId === "string" ? task.tokenDocId.trim() : "";

  if (tokenDocId) {
    const tokenSnap = await db.collection(TOKEN_COLLECTION).doc(tokenDocId).get();
    if (tokenSnap.exists) {
      const data = tokenSnap.data() || {};
      const token = firstString(data.token, data.fcmToken, data.notificationToken);
      const enabled = data.enabled !== false;
      const taskRemindersEnabled = getBooleanSetting(data, [
        "taskRemindersEnabled",
        "taskReminders",
        "enableTaskReminders"
      ], true);

      if (token && enabled && taskRemindersEnabled) {
        return {
          token,
          tokenDocId,
          tokenData: data,
          source: "notification_tokens_matching_task",
          taskRemindersEnabled: true
        };
      }
    }
  }

  const activeToken = await loadMostRecentActiveToken(db);
  if (activeToken) {
    return activeToken;
  }

  return {
    token: firstString(task.token, task.fcmToken, task.notificationToken),
    tokenDocId: tokenDocId || null,
    tokenData: null,
    source: "task_document_legacy_fallback",
    taskRemindersEnabled: true
  };
}

async function loadMostRecentActiveToken(db) {
  const snap = await db.collection(TOKEN_COLLECTION).get();
  const candidates = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const token = firstString(data.token, data.fcmToken, data.notificationToken);
    if (!token) return;
    if (data.enabled === false) return;

    const taskRemindersEnabled = getBooleanSetting(data, [
      "taskRemindersEnabled",
      "taskReminders",
      "enableTaskReminders"
    ], true);

    if (!taskRemindersEnabled) return;

    candidates.push({
      token,
      tokenDocId: doc.id,
      tokenData: data,
      source: "notification_tokens_active_latest",
      taskRemindersEnabled: true,
      sortTime: extractSortTime(data.updatedAt) || extractSortTime(data.createdAt) || 0
    });
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.sortTime - a.sortTime);
  const selected = candidates[0];
  delete selected.sortTime;
  return selected;
}

function extractSortTime(value) {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
  }
  return 0;
}

async function markReminderSent(ref, type) {
  const update = {
    lastReminderSentAt: new Date(),
    lastReminderType: type,
    lastReminderError: null,
    lastReminderErrorAt: null,
    updatedAt: new Date()
  };

  if (type === "1day") update.reminder1DaySent = true;
  if (type === "30min") update.reminder30MinSent = true;
  if (type === "due") update.reminderDueSent = true;

  await ref.set(update, { merge: true });
}

async function markForcedTest(ref, type) {
  await ref.set(
    {
      lastReminderTestSentAt: new Date(),
      lastReminderTestType: type,
      updatedAt: new Date()
    },
    { merge: true }
  );
}

async function markTaskError(ref, message) {
  await ref.set(
    {
      lastReminderError: String(message).slice(0, 500),
      lastReminderErrorAt: new Date(),
      updatedAt: new Date()
    },
    { merge: true }
  );
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function getBooleanSetting(settings, keys, defaultValue) {
  for (const key of keys) {
    if (typeof settings[key] === "boolean") return settings[key];
  }
  return defaultValue;
}

function safeTitle(title) {
  const trimmed = String(title || "Task").trim();
  return trimmed || "Task";
}

function formatMinutes(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes === 1) return "1 minute";
  return `${minutes} minutes`;
}

function resolveTimeZone({ explicitTimeZone = "", task = {}, tokenData = null }) {
  const selectedLocation = tokenData?.selectedLocation || tokenData?.currentLocation || tokenData?.location || null;
  const city = firstString(
    selectedLocation?.city,
    selectedLocation?.name,
    selectedLocation?.label,
    tokenData?.city,
    task.city
  );

  const candidate = firstString(
    explicitTimeZone,
    task.timeZone,
    task.timezone,
    task.tz,
    selectedLocation?.timeZone,
    selectedLocation?.timezone,
    selectedLocation?.tz,
    tokenData?.timeZone,
    tokenData?.timezone,
    process.env.DEFAULT_TIME_ZONE
  );

  if (isValidTimeZone(candidate)) return candidate;

  const cityTimeZone = inferTimeZoneFromCity(city);
  if (cityTimeZone) return cityTimeZone;

  return "Asia/Kolkata";
}

function inferTimeZoneFromCity(city) {
  const c = String(city || "").trim().toLowerCase();
  if (!c) return null;

  if (c.includes("ahmedabad") || c.includes("india")) return "Asia/Kolkata";
  if (c.includes("riga") || c.includes("latvia")) return "Europe/Riga";

  return null;
}

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function formatDateTime(date, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : "Asia/Kolkata";

  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);

  return `${formatted} (${tz})`;
}
