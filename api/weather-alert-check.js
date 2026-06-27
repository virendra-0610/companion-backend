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

  // Test-only switch. Use only manually, not in cron-job.org.
  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ ok: false, error: "Invalid lat/lon" });
  }

  try {
    const tokens = await getNotificationTokens();

    if (tokens.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: "No notification tokens found" });
    }

    const { weather, air } = await getWeatherAndAirQuality({ lat, lon });
    const detectedAlert = analyzeAlert({ weather, air, city });

    const alert = force
      ? {
          type: "forced_weather_test",
          severity: "low",
          title: `Weather alert test for ${city}`,
          body: "Forced test notification from Companion weather scheduler. Real cron will send only when conditions match."
        }
      : detectedAlert;

    if (!alert) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        city,
        message: "No alert condition found",
        debug: buildDebugSummary({ weather, air })
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const alertKey = `${city.toLowerCase()}_${alert.type}_${today}`;

    // Skip duplicate protection only for forced manual test.
    if (!force) {
      const recentlySent = await wasRecentlySent({ key: alertKey, hours: 6 });

      if (recentlySent) {
        return res.status(200).json({
          ok: true,
          sent: 0,
          skipped: true,
          reason: "Duplicate protection active",
          alert,
          debug: buildDebugSummary({ weather, air })
        });
      }
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
            city,
            force: force ? "true" : "false"
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

    if (sent > 0 && !force) {
      await markSent({ key: alertKey, payload: { city, alert, sentCount: sent } });
    }

    return res.status(200).json({
      ok: true,
      city,
      sent,
      forced: force,
      alert,
      debug: buildDebugSummary({ weather, air }),
      results
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function buildDebugSummary({ weather, air }) {
  const hourly = weather?.hourly || {};
  const daily = weather?.daily || {};
  const airHourly = air?.hourly || {};

  return {
    next12RainProbabilityMax: maxFirstN(hourly.precipitation_probability, 12),
    next12PrecipitationMaxMm: maxFirstN(hourly.precipitation, 12),
    next12WindSpeedMaxKmh: maxFirstN(hourly.wind_speed_10m, 12),
    next12WindGustMaxKmh: maxFirstN(hourly.wind_gusts_10m, 12),
    currentUsAqi: firstValid(airHourly.us_aqi),
    tomorrowRainProbabilityMax: daily.precipitation_probability_max?.[1] ?? null,
    tomorrowWindSpeedMaxKmh: daily.wind_speed_10m_max?.[1] ?? null,
    tomorrowWindGustMaxKmh: daily.wind_gusts_10m_max?.[1] ?? null,
    tomorrowWeatherCode: daily.weather_code?.[1] ?? null
  };
}

function maxFirstN(values, n) {
  if (!Array.isArray(values)) return null;

  const nums = values
    .slice(0, n)
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  if (nums.length === 0) return null;
  return Math.max(...nums);
}

function firstValid(values) {
  if (!Array.isArray(values)) return null;

  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }

  return null;
}
