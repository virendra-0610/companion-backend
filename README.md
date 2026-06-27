# Companion Backend

Vercel backend for Companion PWA notifications.

## Endpoints

- `/api/health` - health check
- `/api/test-push?secret=CRON_SECRET` - sends manual test push
- `/api/weather-alert-check?secret=CRON_SECRET&lat=56.9496&lon=24.1052&city=Riga` - real weather/AQI alert check
- `/api/weather-alert-check?secret=CRON_SECRET&lat=56.9496&lon=24.1052&city=Riga&force=1` - forced manual weather test; do not use in cron

## Required Vercel environment variables

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `CRON_SECRET`
- `DEFAULT_LAT`
- `DEFAULT_LON`
- `DEFAULT_CITY`
