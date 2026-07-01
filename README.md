# Companion Backend

Vercel backend endpoints for Companion PWA notifications.

## Endpoints

### Health

```text
/api/health
```

### Test push

```text
/api/test-push?secret=YOUR_CRON_SECRET
```

### Weather/AQI check

Location-aware weather/AQI notification check. Reads location from `notification_tokens/{tokenDocId}.selectedLocation`.

```text
/api/weather-alert-check?secret=YOUR_CRON_SECRET
```

Forced test:

```text
/api/weather-alert-check?secret=YOUR_CRON_SECRET&force=1
```

### Debug tokens

```text
/api/debug-tokens?secret=YOUR_CRON_SECRET
```

### Task reminder check

Checks `todo_tasks` for pending reminders and sends push notifications.

```text
/api/task-reminder-check?secret=YOUR_CRON_SECRET
```

Forced test:

```text
/api/task-reminder-check?secret=YOUR_CRON_SECRET&force=1
```

Dry run:

```text
/api/task-reminder-check?secret=YOUR_CRON_SECRET&dryRun=1
```

## Firestore collections

### notification_tokens

Each token document should contain:

```json
{
  "token": "FCM_TOKEN",
  "weatherAlertsEnabled": true,
  "aqiAlertsEnabled": true,
  "taskRemindersEnabled": true,
  "selectedLocation": {
    "city": "Ahmedabad",
    "lat": 23.0225,
    "lon": 72.5714
  }
}
```

### todo_tasks

Task documents are expected to contain:

```json
{
  "id": "TASK_ID",
  "title": "Task title",
  "dueAt": "Firestore Timestamp",
  "completed": false,
  "deleted": false,
  "token": "FCM_TOKEN",
  "tokenDocId": "notification token doc id",
  "reminder1DaySent": false,
  "reminder30MinSent": false,
  "reminderDueSent": false
}
```

## Recommended cron-job.org schedules

Weather/AQI:

```text
Every 3 hours
https://YOUR_DOMAIN/api/weather-alert-check?secret=YOUR_CRON_SECRET
```

Task reminders:

```text
Every 5 minutes
https://YOUR_DOMAIN/api/task-reminder-check?secret=YOUR_CRON_SECRET
```

Do not use `force=1` in cron jobs.


## v5 Task reminder timezone fix

Task reminder notifications now format due time in local timezone instead of UTC.

Supported test params:

```text
/api/task-reminder-check?secret=YOUR_CRON_SECRET&force=1&timeZone=Asia/Kolkata
/api/task-reminder-check?secret=YOUR_CRON_SECRET&dryRun=1&timeZone=Asia/Kolkata
/api/task-reminder-check?secret=YOUR_CRON_SECRET&force=1&taskId=TASK_ID&timeZone=Asia/Kolkata
```

Production cron should remain:

```text
/api/task-reminder-check?secret=YOUR_CRON_SECRET
```


## v6 changes

- Task reminder token resolution now prefers the latest active `notification_tokens` document when older tasks point to stale token documents.
- This prevents reminder flags from being marked as sent against old/stale task tokens after notification permission is toggled.
