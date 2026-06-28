import { requireCronSecret } from "../lib/auth.js";
import { getNotificationTokens } from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  try {
    const tokens = await getNotificationTokens();

    return res.status(200).json({
      ok: true,
      tokenCount: tokens.length,
      tokens: tokens.map((item) => ({
        docId: item.docId,
        tokenTail: item.token.slice(-8),
        weatherAlertsEnabled: item.data?.weatherAlertsEnabled ?? item.data?.weatherAlerts ?? item.data?.enableWeatherAlerts ?? null,
        aqiAlertsEnabled: item.data?.aqiAlertsEnabled ?? item.data?.aqiAlerts ?? item.data?.enableAqiAlerts ?? null,
        selectedLocation: item.data?.selectedLocation ?? null,
        currentLocation: item.data?.currentLocation ?? null,
        location: item.data?.location ?? null,
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
