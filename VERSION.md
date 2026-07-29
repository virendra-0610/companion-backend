# Companion Backend v14

## Unified reminder endpoint

The existing `/api/task-reminder-check` endpoint now processes both:

- `todo_tasks`
- `personal_events`

The existing cron-job.org schedule remains unchanged. No new cron job and no paid scheduler are required.

## Personal-event reminders

- Custom reminder
- One hour before
- One day before
- Event-day morning at 08:00 in the resolved location timezone
- Multi-device FCM delivery
- Notification history
- Sent flags and error tracking
- `dryRun`, `force`, and direct `eventId` diagnostics

## Important correction

Personal events are scanned independently of `eventAt`, so a custom reminder due now is not missed merely because the event itself is more than 24 hours away.

## Policy

`multi_device_unique_tokens`
