import { getFirestore, getMessaging } from "./firebaseAdmin.js";

export async function getNotificationTokens() {
  const db = getFirestore();
  const snap = await db.collection("notification_tokens").get();
  const tokens = [];

  snap.forEach((doc) => {
    const data = doc.data();
    if (!data) return;

    const token = data.token || data.fcmToken || data.notificationToken;
    if (!token || typeof token !== "string") return;

    if (data.enabled === false) return;

    tokens.push({ docId: doc.id, token, data });
  });

  return tokens;
}

export async function sendPushToToken({ token, title, body, data = {} }) {
  const messaging = getMessaging();

  return messaging.send({
    token,
    notification: { title, body },
    webpush: {
      notification: {
        title,
        body,
        icon: "/icons/Icon-192.png",
        badge: "/icons/Icon-192.png"
      },
      fcmOptions: {
        link: "https://virendra-0610.github.io/companion-web/"
      }
    },
    data: sanitizeData(data)
  });
}

export async function wasRecentlySent({ key, hours = 6 }) {
  const db = getFirestore();
  const ref = db.collection("notification_history").doc(key);
  const snap = await ref.get();

  if (!snap.exists) return false;

  const data = snap.data();
  const sentAt = toDate(data?.sentAt) || toDate(data?.createdAt);
  if (!sentAt) return false;

  const ageMs = Date.now() - sentAt.getTime();
  const maxAgeMs = hours * 60 * 60 * 1000;

  return ageMs < maxAgeMs;
}

export async function markSent({ key, payload }) {
  const alert = payload?.alert || {};
  const city = payload?.city || payload?.location || "";

  await writeNotificationHistory({
    key,
    source: payload?.source || "weather",
    type: payload?.type || alert.type || "weather_alert",
    title: payload?.title || alert.title || "Companion notification",
    body: payload?.body || alert.body || "",
    status: payload?.status || "sent",
    location: city,
    city,
    tokenDocId: payload?.tokenDocId || null,
    runMode: payload?.runMode || "scheduled",
    severity: payload?.severity || alert.severity || null,
    data: payload
  });
}

export async function writeNotificationHistory({
  key = "",
  source = "notification",
  type = "notification",
  title = "Companion",
  body = "",
  status = "sent",
  location = null,
  city = null,
  eventName = null,
  eventDate = null,
  taskId = null,
  tokenDocId = null,
  runMode = "scheduled",
  severity = null,
  error = null,
  data = {}
}) {
  const db = getFirestore();
  const now = new Date();
  const cleanKey = key ? safeHistoryKey(key) : null;
  const ref = cleanKey
    ? db.collection("notification_history").doc(cleanKey)
    : db.collection("notification_history").doc();

  const payload = {
    source: String(source || "notification"),
    type: String(type || "notification"),
    title: String(title || "Companion"),
    body: String(body || ""),
    status: String(status || "sent"),
    runMode: String(runMode || "scheduled"),
    createdAt: now,
    sentAt: status === "sent" ? now : null,
    updatedAt: now,
    test: isTestType(type, runMode, data),
    hiddenFromHistory: isTestType(type, runMode, data)
  };

  if (location) payload.location = String(location);
  if (city) payload.city = String(city);
  if (eventName) payload.eventName = String(eventName);
  if (eventDate) payload.eventDate = String(eventDate);
  if (taskId) payload.taskId = String(taskId);
  if (tokenDocId) payload.tokenDocId = String(tokenDocId);
  if (severity) payload.severity = String(severity);
  if (error) payload.error = String(error).slice(0, 500);

  if (data && typeof data === "object") {
    payload.meta = sanitizeHistoryMeta(data);
  }

  await ref.set(payload, { merge: true });
}

export async function removeBadToken(docId) {
  const db = getFirestore();
  await db.collection("notification_tokens").doc(docId).delete();
}

export function safeHistoryKey(value) {
  return String(value)
    .replace(/[\/#[\]?]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 1400);
}

function sanitizeData(data) {
  const out = {};

  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    out[key] = String(value);
  });

  return out;
}

function sanitizeHistoryMeta(data) {
  const out = {};

  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (["token", "fcmToken", "notificationToken"].includes(key)) return;
    if (typeof value === "object") {
      try {
        out[key] = JSON.parse(JSON.stringify(value));
      } catch (_) {
        out[key] = String(value);
      }
    } else {
      out[key] = value;
    }
  });

  return out;
}

function isTestType(type, runMode, data) {
  const text = `${type || ""} ${runMode || ""} ${data?.force || ""}`.toLowerCase();
  return text.includes("test") || text.includes("force") || text.includes("dryrun") || text.includes("dry_run");
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
