import { requireCronSecret } from "../lib/auth.js";
import { getNotificationTokens, sendPushToToken } from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  try {
    const tokens = await getNotificationTokens();

    if (tokens.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: "No notification tokens found" });
    }

    const results = [];

    for (const item of tokens) {
      try {
        const messageId = await sendPushToToken({
          token: item.token,
          title: "Companion backend active",
          body: "New Vercel backend push test is working.",
          data: { type: "test_push" }
        });

        results.push({ docId: item.docId, ok: true, messageId });
      } catch (error) {
        results.push({ docId: item.docId, ok: false, error: error.message });
      }
    }

    return res.status(200).json({ ok: true, tokenCount: tokens.length, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
