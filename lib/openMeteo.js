export async function getWeatherAndAirQuality({ lat, lon }) {
  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max` +
    `&forecast_days=2` +
    `&timezone=auto`;

  const airUrl =
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&hourly=us_aqi,pm10,pm2_5` +
    `&forecast_days=1` +
    `&timezone=auto`;

  const [weatherRes, airRes] = await Promise.all([
    fetch(weatherUrl),
    fetch(airUrl)
  ]);

  if (!weatherRes.ok) {
    throw new Error(`Open-Meteo weather API failed: ${weatherRes.status}`);
  }

  if (!airRes.ok) {
    throw new Error(`Open-Meteo air quality API failed: ${airRes.status}`);
  }

  const [weather, air] = await Promise.all([
    weatherRes.json(),
    airRes.json()
  ]);

  return { weather, air };
}

export function analyzeAlert({ weather, air, city }) {
  const hourly = weather?.hourly || {};
  const daily = weather?.daily || {};
  const airHourly = air?.hourly || {};

  const next12RainProb = maxFirstN(hourly.precipitation_probability, 12);
  const next12Precip = maxFirstN(hourly.precipitation, 12);
  const next12Wind = maxFirstN(hourly.wind_speed_10m, 12);
  const next12Gust = maxFirstN(hourly.wind_gusts_10m, 12);
  const currentAqi = firstValid(airHourly.us_aqi);

  const tomorrowRainProb = daily.precipitation_probability_max?.[1] ?? null;
  const tomorrowWind = daily.wind_speed_10m_max?.[1] ?? null;
  const tomorrowGust = daily.wind_gusts_10m_max?.[1] ?? null;
  const tomorrowCode = daily.weather_code?.[1] ?? null;

  const alerts = [];

  if (next12RainProb !== null && next12RainProb >= 70) {
    alerts.push({
      type: "rain",
      severity: "medium",
      title: `Rain likely in ${city}`,
      body: `Carry an umbrella. Rain probability is around ${Math.round(next12RainProb)}% in the next 12 hours.`
    });
  }

  if (next12Precip !== null && next12Precip >= 5) {
    alerts.push({
      type: "heavy_rain",
      severity: "high",
      title: `Heavy rain possible in ${city}`,
      body: `Expect wet conditions. Forecast precipitation may reach ${round1(next12Precip)} mm soon.`
    });
  }

  if (next12Gust !== null && next12Gust >= 45) {
    alerts.push({
      type: "wind",
      severity: "high",
      title: `Strong winds expected in ${city}`,
      body: `Wind gusts may reach ${Math.round(next12Gust)} km/h. Avoid exposed areas if possible.`
    });
  } else if (next12Wind !== null && next12Wind >= 30) {
    alerts.push({
      type: "wind",
      severity: "medium",
      title: `Windy conditions in ${city}`,
      body: `Winds may reach ${Math.round(next12Wind)} km/h.`
    });
  }

  if (currentAqi !== null && currentAqi >= 101) {
    alerts.push({
      type: "aqi",
      severity: "high",
      title: `Poor air quality in ${city}`,
      body: `AQI is around ${Math.round(currentAqi)}. Limit long outdoor exposure if sensitive.`
    });
  } else if (currentAqi !== null && currentAqi >= 51) {
    alerts.push({
      type: "aqi",
      severity: "medium",
      title: `Moderate air quality in ${city}`,
      body: `AQI is around ${Math.round(currentAqi)}. Air quality is acceptable but not ideal.`
    });
  }

  if (tomorrowRainProb !== null && tomorrowRainProb >= 70) {
    alerts.push({
      type: "tomorrow_rain",
      severity: "medium",
      title: `Tomorrow may be rainy in ${city}`,
      body: `Plan with an umbrella. Tomorrow rain probability is around ${Math.round(tomorrowRainProb)}%.`
    });
  }

  if (tomorrowGust !== null && tomorrowGust >= 45) {
    alerts.push({
      type: "tomorrow_wind",
      severity: "high",
      title: `Strong winds tomorrow in ${city}`,
      body: `Tomorrow gusts may reach ${Math.round(tomorrowGust)} km/h.`
    });
  } else if (tomorrowWind !== null && tomorrowWind >= 30) {
    alerts.push({
      type: "tomorrow_wind",
      severity: "medium",
      title: `Windy tomorrow in ${city}`,
      body: `Tomorrow wind speed may reach ${Math.round(tomorrowWind)} km/h.`
    });
  }

  if (isSnowCode(tomorrowCode)) {
    alerts.push({
      type: "snow",
      severity: "medium",
      title: `Snow possible tomorrow in ${city}`,
      body: `Expect cold/snowy conditions. Dress warmly and check travel before leaving.`
    });
  }

  return pickHighestPriority(alerts);
}

function maxFirstN(values, n) {
  if (!Array.isArray(values)) return null;
  const nums = values.slice(0, n).filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : null;
}

function firstValid(values) {
  if (!Array.isArray(values)) return null;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function pickHighestPriority(alerts) {
  if (!alerts.length) return null;
  const score = { high: 3, medium: 2, low: 1 };
  return alerts.sort((a, b) => (score[b.severity] || 0) - (score[a.severity] || 0))[0];
}

function isSnowCode(code) {
  return [71, 73, 75, 77, 85, 86].includes(code);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
