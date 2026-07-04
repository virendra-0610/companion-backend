# Companion Backend v12 - Token Dedupe Safety Net

Adds backend-level protection for stale/duplicate FCM tokens.

## Important endpoints

Health:
/api/health

Debug effective delivery token:
/api/debug-tokens?secret=YOUR_SECRET

Show all token docs:
/api/debug-tokens?secret=YOUR_SECRET&all=1

Preview token cleanup:
/api/cleanup-tokens?secret=YOUR_SECRET&dryRun=1

Disable old active tokens and keep only latest:
/api/cleanup-tokens?secret=YOUR_SECRET

## Policy

Even if Firestore accidentally contains multiple `enabled: true` token documents, delivery endpoints use only the latest active token. This prevents duplicate notifications and location mismatch.
