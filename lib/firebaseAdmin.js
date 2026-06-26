import admin from "firebase-admin";

let app;

export function getFirebaseAdmin() {
  if (app) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON env variable");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON. Must be valid JSON.");
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  return admin;
}

export function getFirestore() {
  return getFirebaseAdmin().firestore();
}

export function getMessaging() {
  return getFirebaseAdmin().messaging();
}
