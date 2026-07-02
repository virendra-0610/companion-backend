# companion-backend v9

Backend scheduler endpoints for Companion.

## Changes in v9

- Fixes cultural-reminder dryRun JSON parsing failure by reading holiday API response as text before JSON parsing.
- Uses Nager.Date v4 endpoint first and v3 PublicHolidays endpoint as fallback.
- Adds small Latvia 2026 fallback list so dry-run tests for 2026-06-23/24 work even if the holiday API returns an empty/non-JSON response.
- Keeps all existing endpoints from v8.

## Endpoints

- `/api/health`
- `/api/weather-alert-check?secret=...`
- `/api/task-reminder-check?secret=...`
- `/api/cultural-reminder-check?secret=...`
- `/api/debug-tokens?secret=...`

## Cron URLs

Weather/AQI:

```text
https://companion-vercel-roan.vercel.app/api/weather-alert-check?secret=companion_backend_secret
```

Task reminders:

```text
https://companion-vercel-roan.vercel.app/api/task-reminder-check?secret=companion_backend_secret
```

Cultural reminders:

```text
https://companion-vercel-roan.vercel.app/api/cultural-reminder-check?secret=companion_backend_secret
```

Do not add `force=1` or `dryRun=1` to cron jobs.
