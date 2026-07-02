import { sendPushToToken, removeBadToken, writeNotificationHistory, safeHistoryKey, wasRecentlySent } from "./push.js";

const HOLIDAY_API_BASE = "https://date.nager.at/api/v4/Holidays";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const COUNTRY_NAMES = {
  LV: "Latvia",
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  EE: "Estonia",
  LT: "Lithuania",
  FI: "Finland",
  SE: "Sweden"
};

const WEEKLY_TIPS = {
  LV: [
    "In Latvia, punctuality is valued. Arrive on time for appointments and official visits.",
    "Many Latvian offices and shops may have shorter hours around public holidays. Check timings before going.",
    "Carry an ID document when visiting banks, clinics, government offices, or rental-related appointments.",
    "In Riga, public transport tickets are usually cheaper when bought before boarding or via the official app.",
    "Latvian winters can be icy. Shoes with grip are more useful than formal-looking soles."
  ],
  IN: [
    "For appointments in India, keep a buffer for traffic and parking, especially in larger cities.",
    "Before visiting an office or bank, check whether the day is a local or bank holiday.",
    "For important errands, carry ID proof and a digital copy of key documents.",
    "In hot weather, plan outdoor tasks early morning or evening when possible."
  ],
  DEFAULT: [
    "Check local holiday schedules before planning official work or appointments.",
    "Keep digital copies of important documents accessible when travelling or relocating.",
    "For time-sensitive errands, confirm opening hours before leaving."
  ]
};

export async function checkCulturalReminders({
  tokens = [],
  force = false,
  dryRun = false,
  includeTips = false,
  date = "",
  timeZone = "Asia/Kolkata"
} = {}) {
  const now = resolveNow(date);
  const groups = groupTokensByCountry(tokens);
  const results = [];

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const group of groups) {
    const countryCode = group.countryCode;
    const countryName = countryNameFor(countryCode);
    const locationLabel = group.locationLabel || countryName;

    const reminder = force
      ? buildForcedReminder({ countryName, locationLabel })
      : await buildCulturalReminder({ countryCode, countryName, now, includeTips });

    if (!reminder) {
      skipped += group.tokens.length;
      results.push({
        countryCode,
        countryName,
        location: locationLabel,
        sent: 0,
        skipped: group.tokens.length,
        reason: includeTips ? "No cultural reminder due" : "No public-holiday reminder due"
      });
      continue;
    }

    let groupSent = 0;
    let groupSkipped = 0;
    let groupFailed = 0;
    const tokenResults = [];

    for (const item of group.tokens) {
      const settings = item.data || {};
      const enabled = getBooleanSetting(settings, [
        "culturalRemindersEnabled",
        "culturalReminders",
        "enableCulturalReminders"
      ], true);

      if (!force && !enabled) {
        groupSkipped += 1;
        tokenResults.push({ docId: item.docId, ok: true, skipped: true, reason: "Cultural reminders disabled" });
        continue;
      }

      const key = safeHistoryKey(`cultural_${item.docId}_${countryCode}_${reminder.type}_${reminder.keyDate}`);

      if (!force) {
        const recentlySent = await wasRecentlySent({ key, hours: 36 });
        if (recentlySent) {
          groupSkipped += 1;
          tokenResults.push({ docId: item.docId, ok: true, skipped: true, reason: "Duplicate protection active" });
          continue;
        }
      }

      if (dryRun) {
        groupSkipped += 1;
        tokenResults.push({
          docId: item.docId,
          ok: true,
          dryRun: true,
          reminderType: reminder.type,
          title: reminder.title,
          body: reminder.body
        });
        continue;
      }

      try {
        const messageId = await sendPushToToken({
          token: item.token,
          title: reminder.title,
          body: reminder.body,
          data: {
            type: reminder.type,
            source: "cultural",
            countryCode,
            countryName,
            eventName: reminder.eventName || "",
            eventDate: reminder.eventDate || "",
            force: force ? "true" : "false"
          }
        });

        groupSent += 1;
        tokenResults.push({ docId: item.docId, ok: true, messageId });

        if (!force) {
          await writeNotificationHistory({
            key,
            source: "cultural",
            type: reminder.type,
            title: reminder.title,
            body: reminder.body,
            status: "sent",
            runMode: "scheduled",
            location: locationLabel,
            city: locationLabel,
            eventName: reminder.eventName || null,
            eventDate: reminder.eventDate || null,
            tokenDocId: item.docId,
            data: {
              countryCode,
              countryName,
              reminderType: reminder.type,
              daysUntil: reminder.daysUntil ?? null,
              includeTips
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
            key: safeHistoryKey(`${key}_failed`),
            source: "cultural",
            type: reminder.type,
            title: reminder.title,
            body: reminder.body,
            status: "failed",
            runMode: "scheduled",
            location: locationLabel,
            city: locationLabel,
            eventName: reminder.eventName || null,
            eventDate: reminder.eventDate || null,
            tokenDocId: item.docId,
            error: msg,
            data: { countryCode, countryName, reminderType: reminder.type }
          });
        }

        tokenResults.push({ docId: item.docId, ok: false, error: msg });
      }
    }

    sent += groupSent;
    skipped += groupSkipped;
    failed += groupFailed;

    results.push({
      countryCode,
      countryName,
      location: locationLabel,
      reminder,
      sent: groupSent,
      skipped: groupSkipped,
      failed: groupFailed,
      results: tokenResults
    });
  }

  return {
    nowUtc: now.toISOString(),
    force,
    dryRun,
    includeTips,
    groupCount: groups.length,
    tokenCount: tokens.length,
    sent,
    skipped,
    failed,
    results
  };
}

async function buildCulturalReminder({ countryCode, countryName, now, includeTips }) {
  const holidayReminder = await buildHolidayReminder({ countryCode, countryName, now });
  if (holidayReminder) return holidayReminder;

  if (includeTips && shouldSendWeeklyTip(now)) {
    return buildWeeklyTip({ countryCode, countryName, now });
  }

  return null;
}

async function buildHolidayReminder({ countryCode, countryName, now }) {
  const holidays = await fetchHolidays(countryCode, now.getUTCFullYear());
  const nextYearHolidays = now.getUTCMonth() === 11
    ? await fetchHolidays(countryCode, now.getUTCFullYear() + 1)
    : [];

  const all = [...holidays, ...nextYearHolidays]
    .map((holiday) => ({ ...holiday, dateObj: parseIsoDate(holiday.date) }))
    .filter((holiday) => holiday.dateObj)
    .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  const todayStart = startOfUtcDay(now);

  for (const holiday of all) {
    const daysUntil = Math.round((holiday.dateObj.getTime() - todayStart.getTime()) / ONE_DAY_MS);

    if (daysUntil < 0 || daysUntil > 1) continue;

    const eventName = holiday.localName || holiday.name || "Public holiday";
    const eventDate = formatDate(holiday.dateObj);

    if (daysUntil === 0) {
      return {
        type: "cultural_holiday_today",
        keyDate: holiday.date,
        title: `Public holiday today in ${countryName}`,
        body: `${eventName}. Expect possible closures or reduced hours.`,
        eventName,
        eventDate,
        daysUntil
      };
    }

    return {
      type: "cultural_holiday_tomorrow",
      keyDate: holiday.date,
      title: `Public holiday tomorrow in ${countryName}`,
      body: `${eventName} is tomorrow. Plan official work, shopping, and travel accordingly.`,
      eventName,
      eventDate,
      daysUntil
    };
  }

  return null;
}

async function fetchHolidays(countryCode, year) {
  const url = `${HOLIDAY_API_BASE}/${encodeURIComponent(countryCode)}/${encodeURIComponent(year)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Holiday API failed for ${countryCode}/${year}: ${res.status}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function buildWeeklyTip({ countryCode, countryName, now }) {
  const tips = WEEKLY_TIPS[countryCode] || WEEKLY_TIPS.DEFAULT;
  const weekNumber = getUtcWeekNumber(now);
  const tip = tips[weekNumber % tips.length];

  return {
    type: "cultural_weekly_tip",
    keyDate: `${now.getUTCFullYear()}-W${weekNumber}`,
    title: `${countryName} cultural tip`,
    body: tip,
    eventName: "Cultural tip",
    eventDate: `Week ${weekNumber}`,
    daysUntil: null
  };
}

function buildForcedReminder({ countryName, locationLabel }) {
  return {
    type: "cultural_test",
    keyDate: new Date().toISOString().slice(0, 10),
    title: `Cultural reminder test for ${locationLabel || countryName}`,
    body: `Forced test notification from Companion cultural reminder scheduler. Real cron sends only when a cultural reminder is due.`,
    eventName: "Cultural reminder test",
    eventDate: new Date().toISOString().slice(0, 10),
    daysUntil: null
  };
}

function groupTokensByCountry(tokens) {
  const map = new Map();

  for (const item of tokens) {
    const data = item.data || {};
    const selected = data.selectedLocation || data.currentLocation || data.location || {};
    const countryCode = resolveCountryCode(data, selected);
    const locationLabel = resolveLocationLabel(data, selected, countryCode);
    const key = countryCode;

    if (!map.has(key)) {
      map.set(key, { countryCode, locationLabel, tokens: [] });
    }

    map.get(key).tokens.push(item);
  }

  return Array.from(map.values());
}

function resolveCountryCode(data, selected) {
  const explicit =
    data.culturalCountryCode ||
    data.countryCode ||
    selected.countryCode ||
    selected.country ||
    "";

  const normalized = normalizeCountryCode(explicit);
  if (normalized) return normalized;

  const haystack = [
    data.locationLabel,
    data.timezone,
    selected.city,
    selected.name,
    selected.label,
    selected.displayName,
    selected.country,
    selected.countryName
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("riga") || haystack.includes("latvia") || haystack.includes("europe/riga")) return "LV";
  if (haystack.includes("ahmedabad") || haystack.includes("india") || haystack.includes("asia/kolkata")) return "IN";
  if (haystack.includes("lithuania")) return "LT";
  if (haystack.includes("estonia")) return "EE";
  if (haystack.includes("germany")) return "DE";
  if (haystack.includes("united kingdom") || haystack.includes("london")) return "GB";
  if (haystack.includes("united states") || haystack.includes("usa")) return "US";

  return process.env.DEFAULT_CULTURAL_COUNTRY || "LV";
}

function normalizeCountryCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;

  const lower = raw.toLowerCase();
  if (lower.includes("latvia")) return "LV";
  if (lower.includes("india")) return "IN";
  if (lower.includes("united states") || lower === "usa") return "US";
  if (lower.includes("united kingdom") || lower === "uk") return "GB";
  if (lower.includes("germany")) return "DE";
  if (lower.includes("estonia")) return "EE";
  if (lower.includes("lithuania")) return "LT";

  return "";
}

function resolveLocationLabel(data, selected, countryCode) {
  return (
    data.culturalLocationLabel ||
    selected.displayName ||
    selected.label ||
    selected.city ||
    data.locationLabel ||
    countryNameFor(countryCode)
  );
}

function getBooleanSetting(data, keys, fallback) {
  for (const key of keys) {
    if (typeof data[key] === "boolean") return data[key];
  }
  return fallback;
}

function shouldSendWeeklyTip(now) {
  // Monday UTC. Keep tips predictable and not too frequent.
  return now.getUTCDay() === 1;
}

function resolveNow(date) {
  if (!date) return new Date();
  const parsed = new Date(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function getUtcWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / ONE_DAY_MS) + 1) / 7);
}

function countryNameFor(countryCode) {
  return COUNTRY_NAMES[countryCode] || countryCode;
}
