import { getFirestore, getMessaging } from "./firebaseAdmin.js";

export const TOKEN_POLICY = "multi_device_unique_tokens";
const DEFAULT_APP_URL = "https://companion-web-omega.vercel.app/";

/**
 * Multi-device token policy:
 * - Send to every enabled, unique FCM token.
 * - Keep only one document per exact token value for delivery.
 * - Disabled/stale tokens are ignored.
 * - /api/cleanup-tokens disables duplicate documents for the same exact token,
 *   but does not disable other real devices.
 */
export async function getNotificationTokens(options = {}) {
  const { includeDisabled = false, dedupeLatest = true } = options;
  const tokens = await getAllNotificationTokens({ includeDisabled });

  const active = includeDisabled
    ? tokens
    : tokens.filter((item) => item.data?.enabled !== false);

  if (!dedupeLatest) return active;

  return pickLatestPerToken(active);
}

export async function getAllNotificationTokens({ includeDisabled = false } = {}) {
  const db = getFirestore();
  const snap = await db.collection("notification_tokens").get();
  const tokens = [];

  snap.forEach((doc) => {
    const data = doc.data();
    if (!data) return;

    const token = data.token || data.fcmToken || data.notificationToken;
    if (!token || typeof token !== "string") return;

    if (!includeDisabled && data.enabled === false) return;

    tokens.push({
      docId: doc.id,
      token,
      data,
      sortTime: getTokenSortTime(data)
    });
  });

  tokens.sort(compareTokenItems);
  return tokens;
}

export function pickLatestToken(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  return [...tokens].sort(compareTokenItems)[0];
}

export function pickLatestPerToken(tokens) {
  const seen = new Set();
  const selected = [];

  for (const item of [...(tokens || [])].sort(compareTokenItems)) {
    const key = String(item.token || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }

  return selected;
}

export async function disableOlderActiveTokens({ keepDocId = null, reason = "backend_token_cleanup" } = {}) {
  const db = getFirestore();
  const allActive = await getAllNotificationTokens({ includeDisabled: false });
  const keepByToken = new Map();

  for (const item of allActive) {
    const tokenKey = String(item.token || "").trim();
    if (!tokenKey) continue;

    if (!keepByToken.has(tokenKey)) {
      keepByToken.set(tokenKey, item);
      continue;
    }

    const existing = keepByToken.get(tokenKey);
    const preferred = choosePreferredTokenDoc(existing, item, keepDocId);
    keepByToken.set(tokenKey, preferred);
  }

  const keepDocIds = new Set(Array.from(keepByToken.values()).map((item) => item.docId));
  const batch = db.batch();
  const results = [];

  allActive.forEach((item) => {
    if (keepDocIds.has(item.docId)) return;

    const tokenKey = String(item.token || "").trim();
    const replacement = tokenKey ? keepByToken.get(tokenKey) : null;
    const ref = db.collection("notification_tokens").doc(item.docId);

    batch.set(
      ref,
      {
        enabled: false,
        disabledAt: new Date(),
        disabledReason: reason,
        replacedByTokenDocId: replacement?.docId || null,
        updatedAt: new Date()
      },
      { merge: true }
    );

    results.push({
      docId: item.docId,
      tokenTail: item.token.slice(-8),
      disabled: true,
      replacedByTokenDocId: replacement?.docId || null,
      location: getLocationLabel(item.data)
    });
  });

  if (results.length > 0) {
    await batch.commit();
  }

  return {
    kept: Array.from(keepByToken.values()).map((item) => ({
      docId: item.docId,
      tokenTail: item.token.slice(-8),
      location: getLocationLabel(item.data),
      sortTime: item.sortTime || null
    })),
    disabled: results.length,
    totalActiveBefore: allActive.length,
    totalActiveAfter: keepByToken.size,
    results
  };
}

export async function sendPushToToken({ token, title, body, data = {} }) {
  const messaging = getMessaging();
  const appUrl = normalizeAppUrl(process.env.APP_URL || DEFAULT_APP_URL);

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
        link: appUrl
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

export function getLocationLabel(data = {}) {
  const selected = data.selectedLocation || data.location || data.currentLocation || data.weatherLocation || data.homeLocation || null;
  if (selected && typeof selected === "object") {
    return selected.label || selected.displayName || selected.name || selected.city || selected.country || "";
  }
  return data.label || data.city || "";
}

function compareTokenItems(a, b) {
  const delta = (b.sortTime || getTokenSortTime(b.data)) - (a.sortTime || getTokenSortTime(a.data));
  if (delta !== 0) return delta;
  return String(b.docId).localeCompare(String(a.docId));
}

function choosePreferredTokenDoc(a, b, keepDocId) {
  if (keepDocId && a.docId === keepDocId) return a;
  if (keepDocId && b.docId === keepDocId) return b;
  return compareTokenItems(a, b) <= 0 ? a : b;
}

function getTokenSortTime(data = {}) {
  const candidates = [
    data.lastSyncedAt,
    data.updatedAt,
    data.tokenUpdatedAt,
    data.createdAt,
    data.createdAtLocal,
    data.registeredAt
  ];

  for (const value of candidates) {
    const date = toDate(value);
    if (date) return date.getTime();
  }

  return 0;
}

function normalizeAppUrl(value) {
  const trimmed = String(value || DEFAULT_APP_URL).trim() || DEFAULT_APP_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
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
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}
