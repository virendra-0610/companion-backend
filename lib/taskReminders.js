import { getFirestore } from "./firebaseAdmin.js";
import { sendPushToToken, removeBadToken } from "./push.js";

const TASK_COLLECTION = "todo_tasks";
const TOKEN_COLLECTION = "notification_tokens";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function checkTaskReminders({ force = false, dryRun = false, limit = 100 } = {}) {
  const db = getFirestore();
  const now = new Date();

  const snap = await db
    .collection(TASK_COLLECTION)
    .where("completed", "==", false)
    .where("deleted", "==", false)
    .limit(limit)
    .get();

  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snap.docs) {
    const task = doc.data() || {};
    const taskId = doc.id;
    const dueAt = toDate(task.dueAt);

    if (!dueAt) {
      skipped += 1;
      results.push({ taskId, ok: true, skipped: true, reason: "Missing dueAt" });
      continue;
    }

    const reminder = force
      ? buildForcedReminder(task, dueAt)
      : chooseReminder(task, dueAt, now);

    if (!reminder) {
      skipped += 1;
      results.push({
        taskId,
        ok: true,
        skipped: true,
        title: task.title || "Untitled task",
        dueAt: dueAt.toISOString(),
        reason: "No reminder due"
      });
      continue;
    }

    const tokenResolution = await resolveTaskToken(db, task);

    if (!tokenResolution.token) {
      skipped += 1;
      await markTaskError(doc.ref, `Missing FCM token for task ${taskId}`);
      results.push({ taskId, ok: false, skipped: true, reason: "Missing FCM token" });
      continue;
    }

    if (!force && tokenResolution.taskRemindersEnabled === false) {
      skipped += 1;
      results.push({ taskId, ok: true, skipped: true, reason: "Task reminders disabled" });
      continue;
    }

    const title = reminder.title;
    const body = reminder.body;

    if (dryRun) {
      skipped += 1;
      results.push({
        taskId,
        ok: true,
        dryRun: true,
        reminderType: reminder.type,
        title,
        body,
        dueAt: dueAt.toISOString()
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
          taskId,
          dueAt: dueAt.toISOString(),
          force: force ? "true" : "false"
        }
      });

      await markReminderSent(doc.ref, reminder.type);
      sent += 1;
      results.push({
        taskId,
        ok: true,
        reminderType: reminder.type,
        messageId,
        dueAt: dueAt.toISOString(),
        tokenSource: tokenResolution.source
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

      results.push({ taskId, ok: false, reminderType: reminder.type, error: msg });
    }
  }

  return {
    now: now.toISOString(),
    scanned: snap.size,
    sent,
    skipped,
    failed,
    results
  };
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

function buildForcedReminder(task, dueAt) {
  return {
    type: "forced_task_test",
    flag: null,
    title: "Task reminder test",
    body: `${safeTitle(task.title)} is scheduled for ${formatDateTime(dueAt)}.`
  };
}

async function resolveTaskToken(db, task) {
  const tokenDocId = typeof task.tokenDocId === "string" ? task.tokenDocId.trim() : "";

  if (tokenDocId) {
    const tokenSnap = await db.collection(TOKEN_COLLECTION).doc(tokenDocId).get();
    if (tokenSnap.exists) {
      const data = tokenSnap.data() || {};
      const token = firstString(data.token, data.fcmToken, data.notificationToken);
      return {
        token,
        tokenDocId,
        source: "notification_tokens",
        taskRemindersEnabled: getBooleanSetting(data, [
          "taskRemindersEnabled",
          "taskReminders",
          "enableTaskReminders"
        ], true)
      };
    }
  }

  return {
    token: firstString(task.token, task.fcmToken, task.notificationToken),
    tokenDocId: tokenDocId || null,
    source: "task_document",
    taskRemindersEnabled: true
  };
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

function formatDateTime(date) {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
