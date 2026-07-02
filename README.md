# Companion Backend

Vercel backend endpoints for Companion notifications.

## Endpoints

```text
/api/health
/api/test-push?secret=...
/api/debug-tokens?secret=...
/api/weather-alert-check?secret=...
/api/task-reminder-check?secret=...
/api/cultural-reminder-check?secret=...
```

## Cron jobs

Weather/AQI every 3 hours:

```text
https://companion-vercel-roan.vercel.app/api/weather-alert-check?secret=YOUR_SECRET
```

Task reminders every 1 minute:

```text
https://companion-vercel-roan.vercel.app/api/task-reminder-check?secret=YOUR_SECRET
```

Cultural reminders once daily, morning:

```text
https://companion-vercel-roan.vercel.app/api/cultural-reminder-check?secret=YOUR_SECRET
```

Optional weekly cultural tips, only on Monday UTC:

```text
https://companion-vercel-roan.vercel.app/api/cultural-reminder-check?secret=YOUR_SECRET&tips=1
```

## Cultural reminder notes

- Uses `notification_tokens` settings.
- Reads `culturalRemindersEnabled` / `culturalReminders`.
- Uses `culturalCountryCode` first if present, otherwise tries selected location/city/timezone, then falls back to `DEFAULT_CULTURAL_COUNTRY` or `LV`.
- Public holidays are fetched from Nager.Date.
- `force=1` sends a test notification and does not save a normal history record.
- `dryRun=1` returns JSON only and sends no notification.

## Useful tests

```text
/api/cultural-reminder-check?secret=YOUR_SECRET&dryRun=1
/api/cultural-reminder-check?secret=YOUR_SECRET&force=1
/api/cultural-reminder-check?secret=YOUR_SECRET&dryRun=1&date=2026-06-23
/api/cultural-reminder-check?secret=YOUR_SECRET&dryRun=1&tips=1&date=2026-06-29
```
