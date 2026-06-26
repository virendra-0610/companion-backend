# Companion Backend

Backend notification scheduler endpoints for the Companion Flutter PWA.

## Endpoints

- `/api/health`
- `/api/test-push?secret=YOUR_CRON_SECRET`
- `/api/weather-alert-check?secret=YOUR_CRON_SECRET&lat=56.9496&lon=24.1052&city=Riga`

## Required Vercel Environment Variables

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `CRON_SECRET`
- `DEFAULT_LAT`
- `DEFAULT_LON`
- `DEFAULT_CITY`

## Firebase Service Account

Firebase Console -> Project settings -> Service accounts -> Generate new private key.

Copy the entire JSON content into Vercel as `FIREBASE_SERVICE_ACCOUNT_JSON`.
