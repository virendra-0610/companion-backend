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
  const sentAt = data?.sentAt?.toDate?.();
  if (!sentAt) return false;

  const ageMs = Date.now() - sentAt.getTime();
  const maxAgeMs = hours * 60 * 60 * 1000;

  return ageMs < maxAgeMs;
}

export async function markSent({ key, payload }) {
  const db = getFirestore();

  await db.collection("notification_history").doc(key).set(
    {
      ...payload,
      sentAt: new Date()
    },
    { merge: true }
  );
}

export async function removeBadToken(docId) {
  const db = getFirestore();
  await db.collection("notification_tokens").doc(docId).delete();
}

function sanitizeData(data) {
  const out = {};

  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    out[key] = String(value);
  });

  return out;
}
