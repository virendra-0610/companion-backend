import { getFirestore } from "./firebaseAdmin.js";
import {
  getNotificationTokens,
  sendPushToToken,
  removeBadToken,
  writeNotificationHistory,
  safeHistoryKey,
  TOKEN_POLICY
} from "./push.js";

const EVENT_COLLECTION = "personal_events";
const TOKEN_COLLECTION = "notification_tokens";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export async function checkPersonalEventReminders({
  force = false,
  dryRun = false,
  limit = 200,
  eventId = "",
  timeZone = ""
} = {}) {
  const db = getFirestore();
  const now = new Date();
  const loadResult = await loadCandidateEvents(db, { limit, eventId, now, force, dryRun });
  const results = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of loadResult.docs) {
    try {
      const event = doc.data() || {};
      const effectiveEventId = doc.id;
      const eventAt = toDate(event.eventAt);

      if (!eventAt) {
        skipped += 1;
        results.push({ eventId: effectiveEventId, ok: true, skipped: true, reason: "Missing eventAt" });
        continue;
      }

      if (event.archived === true || event.deleted === true) {
        skipped += 1;
        results.push({ eventId: effectiveEventId, ok: true, skipped: true, reason: "Archived or deleted" });
        continue;
      }

      const tokenResolution = await resolveEventTokens(db, event);
      const effectiveTimeZone = resolveTimeZone({
        explicitTimeZone: timeZone,
        event,
        tokenData: tokenResolution.primaryTokenData
      });

      const reminder = force
        ? buildForcedReminder(event, eventAt, effectiveTimeZone)
        : chooseReminder(event, eventAt, now, effectiveTimeZone);

      if (!reminder) {
        skipped += 1;
        results.push({
          eventId: effectiveEventId,
          ok: true,
          skipped: true,
          title: safeTitle(event.title),
          eventAtUtc: eventAt.toISOString(),
          eventAtLocal: formatDateTime(eventAt, effectiveTimeZone),
          timeZone: effectiveTimeZone,
          reason: "No reminder due"
        });
        continue;
      }

      if (!tokenResolution.tokens.length) {
        skipped += 1;
        await markEventError(doc.ref, `Missing active FCM token for event ${effectiveEventId}`);
        results.push({ eventId: effectiveEventId, ok: false, skipped: true, reason: "Missing active FCM token" });
        continue;
      }

      if (dryRun) {
        skipped += 1;
        results.push({
          eventId: effectiveEventId,
          ok: true,
          dryRun: true,
          reminderType: reminder.type,
          title: reminder.title,
          body: reminder.body,
          reminderAtUtc: reminder.reminderAt.toISOString(),
          eventAtUtc: eventAt.toISOString(),
          eventAtLocal: formatDateTime(eventAt, effectiveTimeZone),
          timeZone: effectiveTimeZone,
          tokenSource: tokenResolution.source,
          tokenCount: tokenResolution.tokens.length,
          tokens: tokenResolution.tokens.map((item) => ({
            tokenDocId: item.tokenDocId || null,
            tokenTail: item.token ? item.token.slice(-8) : null
          }))
        });
        continue;
      }

      const deliveryResults = [];
      let delivered = 0;
      let deliveryFailed = 0;

      for (const target of tokenResolution.tokens) {
        try {
          const messageId = await sendPushToToken({
            token: target.token,
            title: reminder.title,
            body: reminder.body,
            data: {
              type: "personal_event_reminder",
              reminderType: reminder.type,
              eventId: effectiveEventId,
              eventAt: eventAt.toISOString(),
              eventAtLocal: formatDateTime(eventAt, effectiveTimeZone),
              reminderAt: reminder.reminderAt.toISOString(),
              timeZone: effectiveTimeZone,
              force: force ? "true" : "false"
            }
          });

          delivered += 1;
          deliveryResults.push({ tokenDocId: target.tokenDocId || null, ok: true, messageId });
        } catch (deliveryError) {
          const message = deliveryError.message || String(deliveryError);
          deliveryFailed += 1;

          if (
            target.tokenDocId &&
            (message.includes("registration-token-not-registered") || message.includes("invalid-registration-token"))
          ) {
            await removeBadToken(target.tokenDocId);
          }

          deliveryResults.push({ tokenDocId: target.tokenDocId || null, ok: false, error: message });
        }
      }

      if (delivered === 0) {
        failed += 1;
        await markEventError(
          doc.ref,
          deliveryResults.find((item) => item.ok === false)?.error || "All event reminder deliveries failed"
        );
        results.push({
          eventId: effectiveEventId,
          ok: false,
          reminderType: reminder.type,
          reason: "All event reminder deliveries failed",
          deliveries: deliveryResults
        });
        continue;
      }

      if (!force) {
        await markReminderSent(doc.ref, reminder.type);
        await writeNotificationHistory({
          key: safeHistoryKey(`event_${effectiveEventId}_${reminder.type}_${reminder.reminderAt.toISOString()}`),
          source: "personal_event",
          type: `personal_event_reminder_${reminder.type}`,
          title: reminder.title,
          body: reminder.body,
          status: "sent",
          runMode: "scheduled",
          tokenDocId: tokenResolution.tokens[0]?.tokenDocId || null,
          eventName: safeTitle(event.title),
          eventDate: formatDateTime(eventAt, effectiveTimeZone),
          data: {
            eventId: effectiveEventId,
            reminderType: reminder.type,
            eventAtUtc: eventAt.toISOString(),
            eventAtLocal: formatDateTime(eventAt, effectiveTimeZone),
            reminderAtUtc: reminder.reminderAt.toISOString(),
            timeZone: effectiveTimeZone,
            tokenSource: tokenResolution.source,
            sentCount: delivered,
            failedCount: deliveryFailed,
            tokenDocIds: tokenResolution.tokens.map((item) => item.tokenDocId).filter(Boolean),
            tokenPolicy: TOKEN_POLICY
          }
        });
      } else {
        await markForcedTest(doc.ref, reminder.type);
      }

      sent += delivered;
      failed += deliveryFailed;
      results.push({
        eventId: effectiveEventId,
        ok: true,
        reminderType: reminder.type,
        delivered,
        deliveryFailed,
        reminderAtUtc: reminder.reminderAt.toISOString(),
        eventAtUtc: eventAt.toISOString(),
        eventAtLocal: formatDateTime(eventAt, effectiveTimeZone),
        timeZone: effectiveTimeZone,
        tokenSource: tokenResolution.source,
        tokenCount: tokenResolution.tokens.length,
        deliveries: deliveryResults
      });
    } catch (itemError) {
      failed += 1;
      results.push({ eventId: doc.id, ok: false, error: itemError.message || String(itemError) });
      try {
        await markEventError(doc.ref, itemError.message || String(itemError));
      } catch (_) {}
    }
  }

  return {
    nowUtc: now.toISOString(),
    nowLocal: formatDateTime(now, timeZone || process.env.DEFAULT_TIME_ZONE || DEFAULT_TIME_ZONE),
    requestedEventId: eventId || null,
    loadMode: loadResult.mode,
    scanned: loadResult.docs.length,
    sent,
    skipped,
    failed,
    results
  };
}

async function loadCandidateEvents(db, { limit, eventId, now, force, dryRun }) {
  const cleanEventId = String(eventId || "").trim();

  if (cleanEventId) {
    const directSnap = await db.collection(EVENT_COLLECTION).doc(cleanEventId).get();
    if (directSnap.exists) return { docs: [directSnap], mode: "direct_doc" };

    const byIdSnap = await db.collection(EVENT_COLLECTION).where("id", "==", cleanEventId).limit(1).get();
    return { docs: byIdSnap.docs, mode: "where_id" };
  }

  // Full collection scan is intentional. A custom reminder may be due now even
  // when the event itself is several days or months away. Filtering only by
  // eventAt would miss that valid case.
  const snap = await db.collection(EVENT_COLLECTION).get();
  const nowMs = now.getTime();
  const standardLookAheadMs = force || dryRun ? 366 * ONE_DAY_MS : ONE_DAY_MS + TEN_MINUTES_MS;

  const docs = snap.docs
    .filter((doc) => {
      const event = doc.data() || {};
      if (event.archived === true || event.deleted === true) return false;

      const eventAt = toDate(event.eventAt);
      const customAt = toDate(event.customReminderAt);
      const customMayBeDue = customAt && !event.reminderCustomSent && customAt.getTime() >= nowMs - TEN_MINUTES_MS;
      const standardMayBeDue = eventAt && eventAt.getTime() <= nowMs + standardLookAheadMs;
      return force || dryRun || customMayBeDue || standardMayBeDue;
    })
    .sort((a, b) => nextReminderSortTime(a.data() || {}, now) - nextReminderSortTime(b.data() || {}, now))
    .slice(0, limit);

  return { docs, mode: "full_scan_custom_reminder_safe" };
}

function nextReminderSortTime(event, now) {
  const candidates = [];
  const eventAt = toDate(event.eventAt);
  const customAt = toDate(event.customReminderAt);
  if (customAt && !event.reminderCustomSent) candidates.push(customAt.getTime());
  if (eventAt) {
    if (event.remindOneHourBefore === true && !event.reminder1HourSent) candidates.push(eventAt.getTime() - ONE_HOUR_MS);
    if (event.remindOneDayBefore === true && !event.reminder1DaySent) candidates.push(eventAt.getTime() - ONE_DAY_MS);
    if (event.remindMorningOf === true && !event.reminderMorningSent) candidates.push(eventAt.getTime());
  }
  return candidates.length ? Math.min(...candidates) : now.getTime();
}

function chooseReminder(event, eventAt, now, timeZone) {
  const nowMs = now.getTime();
  const candidates = [];
  const customAt = toDate(event.customReminderAt);

  if (customAt && event.reminderCustomSent !== true) {
    candidates.push(buildCandidate({
      type: "custom",
      reminderAt: customAt,
      title: "Event reminder",
      body: eventBody(event, "is coming up")
    }));
  }

  if (event.remindOneHourBefore === true && event.reminder1HourSent !== true) {
    candidates.push(buildCandidate({
      type: "1hour",
      reminderAt: new Date(eventAt.getTime() - ONE_HOUR_MS),
      title: "Event in one hour",
      body: eventBody(event, "starts in one hour")
    }));
  }

  if (event.remindOneDayBefore === true && event.reminder1DaySent !== true) {
    candidates.push(buildCandidate({
      type: "1day",
      reminderAt: new Date(eventAt.getTime() - ONE_DAY_MS),
      title: "Event tomorrow",
      body: eventBody(event, "is tomorrow")
    }));
  }

  if (event.remindMorningOf === true && event.reminderMorningSent !== true) {
    candidates.push(buildCandidate({
      type: "morning",
      reminderAt: morningOfEvent(eventAt, timeZone),
      title: `${safeTitle(event.title)} is today`,
      body: eventBody(event, "is scheduled for today")
    }));
  }

  return candidates
    .filter(Boolean)
    .filter((candidate) => {
      const target = candidate.reminderAt.getTime();
      return target <= nowMs + FIVE_MINUTES_MS && target >= nowMs - TEN_MINUTES_MS;
    })
    .sort((a, b) => a.reminderAt.getTime() - b.reminderAt.getTime())[0] || null;
}

function buildCandidate({ type, reminderAt, title, body }) {
  if (!(reminderAt instanceof Date) || !Number.isFinite(reminderAt.getTime())) return null;
  return { type, reminderAt, title, body };
}

function buildForcedReminder(event, eventAt, timeZone) {
  return {
    type: "forced_event_test",
    reminderAt: new Date(),
    title: "Event reminder test",
    body: `${safeTitle(event.title)} is scheduled for ${formatDateTime(eventAt, timeZone)}.`
  };
}

async function resolveEventTokens(db, event) {
  const activeTokens = await getNotificationTokens();
  const deliveryTargets = activeTokens
    .filter((item) => getBooleanSetting(item.data || {}, [
      "eventRemindersEnabled",
      "personalEventRemindersEnabled",
      "taskRemindersEnabled"
    ], true))
    .map((item) => ({
      token: item.token,
      tokenDocId: item.docId,
      tokenData: item.data || null,
      source: "notification_tokens_multi_device"
    }));

  if (deliveryTargets.length > 0) {
    return {
      tokens: deliveryTargets,
      primaryTokenData: deliveryTargets[0].tokenData,
      source: "notification_tokens_multi_device"
    };
  }

  const tokenDocId = typeof event.tokenDocId === "string" ? event.tokenDocId.trim() : "";
  if (tokenDocId) {
    const tokenSnap = await db.collection(TOKEN_COLLECTION).doc(tokenDocId).get();
    if (tokenSnap.exists) {
      const data = tokenSnap.data() || {};
      const token = firstString(data.token, data.fcmToken, data.notificationToken);
      if (token && data.enabled !== false) {
        return {
          tokens: [{ token, tokenDocId, tokenData: data, source: "notification_tokens_matching_event" }],
          primaryTokenData: data,
          source: "notification_tokens_matching_event"
        };
      }
    }
  }

  const legacyToken = firstString(event.token, event.fcmToken, event.notificationToken);
  if (legacyToken) {
    return {
      tokens: [{ token: legacyToken, tokenDocId: tokenDocId || null, tokenData: null, source: "event_document_fallback" }],
      primaryTokenData: null,
      source: "event_document_fallback"
    };
  }

  return { tokens: [], primaryTokenData: null, source: "missing_token" };
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
  if (type === "1hour") update.reminder1HourSent = true;
  if (type === "morning") update.reminderMorningSent = true;
  if (type === "custom") update.reminderCustomSent = true;
  await ref.set(update, { merge: true });
}

async function markForcedTest(ref, type) {
  await ref.set({ lastReminderTestSentAt: new Date(), lastReminderTestType: type, updatedAt: new Date() }, { merge: true });
}

async function markEventError(ref, message) {
  await ref.set({
    lastReminderError: String(message).slice(0, 500),
    lastReminderErrorAt: new Date(),
    updatedAt: new Date()
  }, { merge: true });
}

function eventBody(event, phrase) {
  const location = String(event.location || "").trim();
  return `${safeTitle(event.title)} ${phrase}${location ? ` at ${location}` : ""}.`;
}

function morningOfEvent(eventAt, timeZone) {
  const parts = zonedParts(eventAt, timeZone);
  return zonedDateToUtc({ year: parts.year, month: parts.month, day: parts.day, hour: 8, minute: 0 }, timeZone);
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values;
}

function zonedDateToUtc(parts, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(new Date(guess), tz);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second || 0);
    const desiredAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    guess += desiredAsUtc - actualAsUtc;
  }
  return new Date(guess);
}

function resolveTimeZone({ explicitTimeZone = "", event = {}, tokenData = null }) {
  const selectedLocation = tokenData?.selectedLocation || tokenData?.currentLocation || tokenData?.location || null;
  const city = firstString(selectedLocation?.city, selectedLocation?.name, selectedLocation?.label, tokenData?.city, event.city, event.location);
  const candidate = firstString(
    explicitTimeZone,
    event.timeZone,
    event.timezone,
    event.tz,
    selectedLocation?.timeZone,
    selectedLocation?.timezone,
    selectedLocation?.tz,
    tokenData?.timeZone,
    tokenData?.timezone,
    process.env.DEFAULT_TIME_ZONE
  );
  if (isValidTimeZone(candidate)) return candidate;
  const cityTimeZone = inferTimeZoneFromCity(city);
  return cityTimeZone || DEFAULT_TIME_ZONE;
}

function inferTimeZoneFromCity(city) {
  const value = String(city || "").trim().toLowerCase();
  if (!value) return null;
  if (value.includes("ahmedabad") || value.includes("gandhinagar") || value.includes("gujarat") || value.includes("india")) return "Asia/Kolkata";
  if (value.includes("riga") || value.includes("latvia")) return "Europe/Riga";
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
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  return `${new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date)} (${tz})`;
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
  const value = String(title || "Personal event").trim();
  return value || "Personal event";
}
