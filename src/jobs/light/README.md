# Light Job Placeholder

This directory is reserved for the future POE light/queue cron plugin.

Planned config keys:

- `LIGHT_QUEUE`
- `LIGHT_SUB_QUEUE`
- `LIGHT_STATE_FILE_PATH`
- `LIGHT_LOCK_FILE_PATH`
- `LIGHT_TG_CHAT_ID`

The future plugin should use the shared `src/lib` runner and compare only the configured
`LIGHT_QUEUE` + `LIGHT_SUB_QUEUE` state fingerprint.
