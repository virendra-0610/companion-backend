import { requireCronSecret } from "../lib/auth.js";
import { getWeatherAndAirQuality, analyzeAlert } from "../lib/openMeteo.js";
import {
  getNotificationTokens,
  sendPushToToken,
  wasRecentlySent,
  markSent,
  writeNotificationHistory,
  removeBadToken
} from "../lib/push.js";

export default async function handler(req, res) {
  const auth = requireCronSecret(req);

  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const force = String(req.query.force || "").toLowerCase() === "true" || req.query.force === "1";

  try {
    const tokens = await getNotificationTokens();

    if (tokens.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: "No notification tokens found" });
    }

    const defaultLocation = resolveRequestDefaultLocation(req);
    const groups = groupTokensByLocation(tokens, defaultLocation);

    const groupResults = [];
    let totalSent = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const group of groups) {
      const { lat, lon, city } = group.location;

      const { weather, air } = await getWeatherAndAirQuality({ lat, lon });
      const detectedAlert = analyzeAlert({ weather, air, city });

      const alert = force
        ? {
            type: "forced_weather_test",
            severity: "low",
            title: `Weather alert test for ${city}`,
            body: `Forced test notification from Companion weather scheduler for ${city}. Real cron will send only when conditions match.`
          }
        : detectedAlert;

      const debug = buildDebugSummary({ weather, air });

      if (!alert) {
        totalSkipped += group.tokens.length;
        groupResults.push({
          city,
          lat,
          lon,
          sent: 0,
          skipped: group.tokens.length,
          message: "No alert condition found",
          debug
        });
        continue;
      }

      const today = new Date().toISOString().slice(0, 10);
      const tokenResults = [];
      let groupSent = 0;
      let groupSkipped = 0;
      let groupFailed = 0;

      for (const item of group.tokens) {
        const settings = item.data || {};
        const weatherEnabled = getBooleanSetting(settings, [
          "weatherAlertsEnabled",
          "weatherAlerts",
          "enableWeatherAlerts"
        ], true);
        const aqiEnabled = getBooleanSetting(settings, [
          "aqiAlertsEnabled",
          "aqiAlerts",
          "enableAqiAlerts"
        ], true);

        if (alert.type.includes("aqi") && !aqiEnabled) {
          groupSkipped += 1;
          tokenResults.push({ docId: item.docId, ok: true, skipped: true, reason: "AQI alerts disabled" });
          continue;
        }

        if (!alert.type.includes("aqi") && !weatherEnabled) {
          groupSkipped += 1;
          tokenResults.push({ docId: item.docId, ok: true, skipped: true, reason: "Weather alerts disabled" });
          continue;
        }

        const alertKey = safeHistoryKey(`weather_${item.docId}_${city}_${alert.type}_${today}`);

        if (!force) {
          const recentlySent = await wasRecentlySent({ key: alertKey, hours: 6 });
          if (recentlySent) {
            groupSkipped += 1;
            tokenResults.push({
              docId: item.docId,
              ok: true,
              skipped: true,
              reason: "Duplicate protection active"
            });
            continue;
          }
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
              lat: String(lat),
              lon: String(lon),
              force: force ? "true" : "false"
            }
          });

          groupSent += 1;
          tokenResults.push({ docId: item.docId, ok: true, messageId });

          if (!force) {
            await markSent({
              key: alertKey,
              payload: {
                source: alert.type.includes("aqi") ? "aqi" : "weather",
                type: alert.type,
                title: alert.title,
                body: alert.body,
                status: "sent",
                runMode: "scheduled",
                city,
                location: city,
                lat,
                lon,
                alert,
                tokenDocId: item.docId,
                severity: alert.severity,
                sentCount: 1
              }
            });
          }
        } catch (error) {
          const msg = error.message || "";
          groupFailed += 1;

          if (msg.includes("registration-token-not-registered") || msg.includes("invalid-registration-token")) {
            await removeBadToken(item.docId);
          }

          if (!force) {
            await writeNotificationHistory({
              key: safeHistoryKey(`weather_failed_${item.docId}_${city}_${alert.type}_${today}`),
              source: alert.type.includes("aqi") ? "aqi" : "weather",
              type: alert.type,
              title: alert.title,
              body: alert.body,
              status: "failed",
              runMode: "scheduled",
              location: city,
              city,
              tokenDocId: item.docId,
              severity: alert.severity,
              error: msg,
              data: { city, lat, lon, alert }
            });
          }

          tokenResults.push({ docId: item.docId, ok: false, error: msg });
        }
      }

      totalSent += groupSent;
      totalSkipped += groupSkipped;
      totalFailed += groupFailed;

      groupResults.push({
        city,
        lat,
        lon,
        sent: groupSent,
        skipped: groupSkipped,
        failed: groupFailed,
        forced: force,
        alert,
        debug,
        results: tokenResults
      });
    }

    return res.status(200).json({
      ok: true,
      mode: "location-aware",
      forced: force,
      tokenCount: tokens.length,
      locationCount: groups.length,
      sent: totalSent,
      skipped: totalSkipped,
      failed: totalFailed,
      groups: groupResults
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function resolveRequestDefaultLocation(req) {
  const lat = Number(req.query.lat || process.env.DEFAULT_LAT || 56.9496);
  const lon = Number(req.query.lon || process.env.DEFAULT_LON || 24.1052);
  const city = String(req.query.city || process.env.DEFAULT_CITY || "Riga").trim() || "Riga";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("Invalid default lat/lon");
  }

  return { lat, lon, city };
}

function groupTokensByLocation(tokens, defaultLocation) {
  const map = new Map();

  for (const item of tokens) {
    const location = resolveTokenLocation(item.data, defaultLocation);
    const key = `${roundCoord(location.lat)},${roundCoord(location.lon)},${location.city.toLowerCase()}`;

    if (!map.has(key)) {
      map.set(key, { location, tokens: [] });
    }

    map.get(key).tokens.push(item);
  }

  return Array.from(map.values());
}

function resolveTokenLocation(data = {}, defaultLocation) {
  const candidates = [
    data.selectedLocation,
    data.currentLocation,
    data.location,
    data.weatherLocation,
    data.homeLocation,
    data
  ];

  for (const candidate of candidates) {
    const parsed = parseLocationCandidate(candidate);
    if (parsed) return parsed;
  }

  return defaultLocation;
}

function parseLocationCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;

  const lat = Number(
    candidate.lat ??
      candidate.latitude ??
      candidate.coord?.lat ??
      candidate.coords?.lat ??
      candidate.position?.lat
  );

  const lon = Number(
    candidate.lon ??
      candidate.lng ??
      candidate.longitude ??
      candidate.coord?.lon ??
      candidate.coords?.lon ??
      candidate.coords?.lng ??
      candidate.position?.lon ??
      candidate.position?.lng
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const city = String(
    candidate.city ??
      candidate.name ??
      candidate.label ??
      candidate.displayName ??
      candidate.address?.city ??
      "Selected location"
  ).trim();

  return {
    lat,
    lon,
    city: city || "Selected location"
  };
}

function getBooleanSetting(settings, keys, defaultValue) {
  for (const key of keys) {
    if (typeof settings[key] === "boolean") return settings[key];
  }
  return defaultValue;
}

function safeHistoryKey(value) {
  return String(value)
    .replace(/[\/#[\]?]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 1400);
}

function roundCoord(value) {
  return Math.round(Number(value) * 10000) / 10000;
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
