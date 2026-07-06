# Companion Backend v13

## Policy

`multi_device_unique_tokens`

## What changed

- Sends notifications to every enabled unique FCM token/device.
- Keeps one notification history record per alert/task/cultural reminder instead of one per device.
- Cleanup endpoint now disables exact duplicate token documents only. It does not disable other real devices.
- Push click URL uses `APP_URL`, falling back to `https://companion-web-omega.vercel.app/`.
- Preserves weather/AQI, task reminders, cultural reminders, cleanup, debug and test-push endpoints.
