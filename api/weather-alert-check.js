import { requireCronSecret } from "../lib/auth.js";
import { getWeatherAndAirQuality, analyzeAlert } from "../lib/openMeteo.js";
import {
  getNotificationTokens,
  sendPushToToken,
  wasRecentlySent,
  markSent,
  removeBadToken
} from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const lat = Number(req.query.lat || process.env.DEFAULT_LAT || 56.9496);
  const lon = Number(req.query.lon || process.env.DEFAULT_LON || 24.1052);
  const city = String(req.query.city || process.env.DEFAULT_CITY || "Riga");

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
  }

  try {
    const tokens = await getNotificationTokens();

    if (tokens.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: "No notification tokens found" });
    }

    const { weather, air } = await getWeatherAndAirQuality({ lat, lon });
    const alert = analyzeAlert({ weather, air, city });

    if (!alert) {
      return res.status(200).json({ ok: true, sent: 0, city, message: "No alert condition found" });
    }

    const alertKey = `${city.toLowerCase()}_${alert.type}_${new Date().toISOString().slice(0, 10)}`;
    const recentlySent = await wasRecentlySent({ key: alertKey, hours: 6 });

    if (recentlySent) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        skipped: true,
        reason: "Duplicate protection active",
        alert
      });
    }

    const results = [];
    let sent = 0;

    for (const item of tokens) {
      const settings = item.data || {};

      const weatherEnabled =
        settings.weatherAlertsEnabled ??
        settings.weatherAlerts ??
        settings.enableWeatherAlerts ??
        true;

      const aqiEnabled =
        settings.aqiAlertsEnabled ??
        settings.aqiAlerts ??
        settings.enableAqiAlerts ??
        true;

      if (alert.type.includes("aqi") && !aqiEnabled) {
        results.push({ docId: item.docId, ok: true, skipped: true, reason: "AQI alerts disabled" });
        continue;
      }

      if (!alert.type.includes("aqi") && !weatherEnabled) {
        results.push({ docId: item.docId, ok: true, skipped: true, reason: "Weather alerts disabled" });
        continue;
      }

      try {
        const messageId = await sendPushToToken({
          token: item.token,
          title: alert.title,
          body: alert.body,
          data: {
            type: alert.type,
            severity: alert.severity,
            city
          }
        });

        sent += 1;
        results.push({ docId: item.docId, ok: true, messageId });
      } catch (error) {
        const msg = error.message || "";

        if (msg.includes("registration-token-not-registered") || msg.includes("invalid-registration-token")) {
          await removeBadToken(item.docId);
        }

        results.push({ docId: item.docId, ok: false, error: msg });
      }
    }

    if (sent > 0) {
      await markSent({ key: alertKey, payload: { city, alert, sentCount: sent } });
    }

    return res.status(200).json({ ok: true, city, sent, alert, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
