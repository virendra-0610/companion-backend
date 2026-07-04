import { requireCronSecret } from "../lib/auth.js";
import { disableOlderActiveTokens, getAllNotificationTokens, getNotificationTokens } from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  try {
    const dryRun = String(req.query.dryRun || "") === "1";
    const beforeDelivery = await getNotificationTokens();
    const beforeActive = await getAllNotificationTokens({ includeDisabled: false });

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "cleanup-tokens",
        dryRun: true,
        tokenPolicy: "single_latest_active_token",
        deliveryTokenCount: beforeDelivery.length,
        rawActiveTokenCount: beforeActive.length,
        wouldDisable: Math.max(0, beforeActive.length - beforeDelivery.length),
        keep: beforeDelivery[0]
          ? {
              docId: beforeDelivery[0].docId,
              tokenTail: beforeDelivery[0].token.slice(-8),
              location: beforeDelivery[0].data?.selectedLocation?.label || beforeDelivery[0].data?.selectedLocation?.city || beforeDelivery[0].data?.city || null
            }
          : null,
        activeTokens: beforeActive.map((item) => ({
          docId: item.docId,
          tokenTail: item.token.slice(-8),
          location: item.data?.selectedLocation?.label || item.data?.selectedLocation?.city || item.data?.city || null,
          sortTime: item.sortTime || null
        }))
      });
    }

    const cleanup = await disableOlderActiveTokens({ reason: "manual_backend_cleanup_tokens_endpoint" });
    const afterDelivery = await getNotificationTokens();
    const afterActive = await getAllNotificationTokens({ includeDisabled: false });

    return res.status(200).json({
      ok: true,
      mode: "cleanup-tokens",
      dryRun: false,
      tokenPolicy: "single_latest_active_token",
      before: {
        deliveryTokenCount: beforeDelivery.length,
        rawActiveTokenCount: beforeActive.length
      },
      cleanup,
      after: {
        deliveryTokenCount: afterDelivery.length,
        rawActiveTokenCount: afterActive.length
      }
    });
  } catch (error) {
    return res.status(200).json({ ok: false, error: error.message });
  }
}
