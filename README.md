# Companion Backend v11 - Task Expired Cleanup

Adds `cleanupExpired=1` to `/api/task-reminder-check` for one-time cleanup of old expired pending tasks.

## Normal cron URL

```text
/api/task-reminder-check?secret=YOUR_SECRET
```

## One-time expired task cleanup

```text
/api/task-reminder-check?secret=YOUR_SECRET&cleanupExpired=1&timeZone=Asia/Kolkata
```

## Dry run cleanup preview

```text
/api/task-reminder-check?secret=YOUR_SECRET&cleanupExpired=1&dryRun=1&timeZone=Asia/Kolkata
```

Do not add `cleanupExpired=1` to cron. Use it manually when old expired pending tasks need cleanup.
