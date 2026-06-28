# Companion Backend

Vercel backend endpoints for Companion PWA notifications.

## Endpoints

- `/api/health`
- `/api/test-push?secret=...`
- `/api/weather-alert-check?secret=...`
- `/api/weather-alert-check?secret=...&force=1` for manual weather push test only
- `/api/debug-tokens?secret=...` to inspect stored token settings/location without exposing full FCM tokens

## v3 changes

Weather/AQI notification checks are now location-aware.

The backend reads location from each Firestore `notification_tokens/{docId}` document using one of these shapes:

```json
{
  "selectedLocation": { "city": "Ahmedabad", "lat": 23.0225, "lon": 72.5714 }
}
```

or:

```json
{
  "city": "Ahmedabad",
  "lat": 23.0225,
  "lon": 72.5714
}
```

Fallback remains `DEFAULT_CITY`, `DEFAULT_LAT`, and `DEFAULT_LON` if the token document has no location.

Cron URL should use the stable production domain and no `force=1`:

```txt
https://companion-vercel-roan.vercel.app/api/weather-alert-check?secret=YOUR_SECRET
```
