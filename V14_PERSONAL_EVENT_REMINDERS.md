# V14 Personal Event Reminder Integration

## Architecture

cron-job.org → `/api/task-reminder-check` → task + personal-event checks → Firestore → FCM

## Deployment

Deploy this backend repository to the existing Vercel project. Do not create another cron-job.org entry. The existing task-reminder URL continues to work.

## Test URLs

Use the existing secret parameter.

- Dry run all due reminders: `/api/task-reminder-check?secret=YOUR_SECRET&dryRun=1`
- Dry run one event: `/api/task-reminder-check?secret=YOUR_SECRET&dryRun=1&eventId=EVENT_ID`
- Force-test one event: `/api/task-reminder-check?secret=YOUR_SECRET&force=1&eventId=EVENT_ID`

The force test sends immediately and does not mark the normal reminder flag as sent.
