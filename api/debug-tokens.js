import { requireCronSecret } from "../lib/auth.js";
import { getAllNotificationTokens, getNotificationTokens } from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  try {
    const deliveryTokens = await getNotificationTokens();
    const activeRawTokens = await getAllNotificationTokens({ includeDisabled: false });
    const allTokens = await getAllNotificationTokens({ includeDisabled: true });
    const showAll = String(req.query.all || "") === "1";
    const visibleTokens = showAll ? allTokens : deliveryTokens;
    const deliveryDocIds = new Set(deliveryTokens.map((item) => item.docId));

    return res.status(200).json({
      ok: true,
      tokenPolicy: "single_latest_active_token",
      tokenCount: deliveryTokens.length,
      rawActiveTokenCount: activeRawTokens.length,
      totalTokenDocs: allTokens.length,
      ignoredActiveDuplicates: Math.max(0, activeRawTokens.length - deliveryTokens.length),
      showAll,
      tokens: visibleTokens.map((item) => ({
        docId: item.docId,
        tokenTail: item.token.slice(-8),
        enabled: item.data?.enabled !== false,
        activeForDelivery: deliveryDocIds.has(item.docId),
        sortTime: item.sortTime || null,
        weatherAlertsEnabled: item.data?.weatherAlertsEnabled ?? item.data?.weatherAlerts ?? item.data?.enableWeatherAlerts ?? null,
        aqiAlertsEnabled: item.data?.aqiAlertsEnabled ?? item.data?.aqiAlerts ?? item.data?.enableAqiAlerts ?? null,
        taskRemindersEnabled: item.data?.taskRemindersEnabled ?? item.data?.taskReminders ?? null,
        culturalRemindersEnabled: item.data?.culturalRemindersEnabled ?? item.data?.culturalReminders ?? null,
        selectedLocation: item.data?.selectedLocation ?? null,
        currentLocation: item.data?.currentLocation ?? null,
        location: item.data?.location ?? null,
        disabledReason: item.data?.disabledReason ?? null,
        replacedByTokenDocId: item.data?.replacedByTokenDocId ?? null,
        rootLocationFields: {
          city: item.data?.city ?? null,
          lat: item.data?.lat ?? item.data?.latitude ?? null,
          lon: item.data?.lon ?? item.data?.lng ?? item.data?.longitude ?? null
        }
      }))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
