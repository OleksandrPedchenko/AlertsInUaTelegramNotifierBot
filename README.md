# Alerts Cron Worker

One-shot Node.js job that fetches active air raid alert state for a region and triggers a notifier.

## Requirements

- Node.js 18.18+ (Node 20+ recommended)

## Setup

1. Install dependencies:
   ```bash
   npm install --cache .npm-cache
   ```
2. Create `.env` from `.env.example` and set your real `ALERTS_API_TOKEN`, `TG_BOT_TOKEN`, and `TG_CHAT_ID`.
3. Run once manually:
   ```bash
   npm start
   ```

## Environment Variables

- `ALERTS_API_TOKEN` (required): bearer token for Alerts API.
- `ALERTS_API_HOST` (optional): default `https://api.alerts.in.ua`.
- `ALERTS_API_PATH_TEMPLATE` (optional): default `/v1/iot/active_air_raid_alerts/{regionId}.json`.
- `ALERTS_USE_ACTIVE_ENDPOINT` (optional): if `true`, uses active alerts endpoint (`/v1/alerts/active.json`) and maps response to `A/N` based on matching criteria. Default `false`.
- `ALERTS_ACTIVE_API_PATH` (optional): endpoint path used when `ALERTS_USE_ACTIVE_ENDPOINT=true`. Default `/v1/alerts/active.json`.
- `ALERTS_ACTIVE_MATCH_CRITERIA` (required when `ALERTS_USE_ACTIVE_ENDPOINT=true`): JSON object for exact alert match (all provided keys must match exactly). Example: `{"alert_type":"air_raid","location_oblast":"Полтавська область","finished_at":null}`.
- `ALERTS_ACTIVE_STUB_FILE` (optional): local JSON file path used for stub mode in active endpoint mode. Default `response.json` (resolved from project root).
- `REGION_ID` (optional): default `19`.
- `TG_BOT_TOKEN` (required): Telegram bot token from BotFather.
- `TG_CHAT_ID` (required): target chat ID (user/group/channel).
- `ALERTS_USE_STUB` (optional): if `true`, skips external API request and uses local stub. Default `false`.
- `ALERTS_STUB_RESPONSE` (optional): stub alert state char (`N`, `A`, or `P`) for legacy endpoint mode only. Default `N`.
- `ALWAYS_SEND_TG_MESSAGE` (optional): if `true`, always sends Telegram message and skips diff check. Default `false`.
- `TREAT_P_AS_A` (optional): if `true`, converts incoming `P` status to `A` before diff check and notification template selection. Default `false`.
- `HTTP_TIMEOUT_MS` (optional): request timeout in milliseconds, default `10000`.
- `HTTP_MAX_RETRIES` (optional): number of retries for transient failures, default `2`.
- `HTTP_RETRY_BASE_DELAY_MS` (optional): linear backoff base delay in milliseconds, default `500`.
- `TG_HTTP_TIMEOUT_MS` (optional): Telegram request timeout in milliseconds, default `10000`.
- `TG_HTTP_MAX_RETRIES` (optional): Telegram request retries for transient failures, default `2`.
- `TG_HTTP_RETRY_BASE_DELAY_MS` (optional): Telegram retry base delay in milliseconds, default `500`.
- `LOCK_FILE_PATH` (optional): lock file path, default `.alerts-job.lock`.
- `STATE_FILE_PATH` (optional): persisted last-seen state file, default `.alerts-last-state.json`.

## Cron Setup (Every N Minutes)

Use system cron to execute this one-shot script every `N` minutes.

Example for every `5` minutes:

```cron
*/5 * * * * cd /Users/olexandrpedchenko/projects/AlertsTgBot && /usr/bin/env node src/index.js >> /Users/olexandrpedchenko/projects/AlertsTgBot/logs/cron.log 2>&1
```

Before enabling cron logging, create the logs directory:

```bash
mkdir -p logs
```

## Notes

- In legacy mode, successful API response is expected to be a single char: `N`, `A`, or `P`.
- In active endpoint mode (`ALERTS_USE_ACTIVE_ENDPOINT=true`), response is expected to be JSON with an `alerts` array. The worker emits `A` if at least one object matches:
  - `ALERTS_ACTIVE_MATCH_CRITERIA` (exact key/value matching).
  Otherwise it emits `N`.
- If both `ALERTS_USE_STUB=true` and `ALERTS_USE_ACTIVE_ENDPOINT=true`, stub data is loaded from `ALERTS_ACTIVE_STUB_FILE` instead of `ALERTS_STUB_RESPONSE`.
- For active development without consuming API limits, set `ALERTS_USE_STUB=true`.
- Notifications are sent via Telegram Bot API `sendMessage`.
- Notification is sent only when current state differs from the previously stored state.
- Set `ALWAYS_SEND_TG_MESSAGE=true` to bypass the diff check and notify on every run.
- Set `TREAT_P_AS_A=true` if your business rule requires treating partial alert (`P`) as full alert (`A`).
- The job uses a lock file to avoid overlapping runs.
- Logs are emitted as JSON lines for easier ingestion in production logging systems.
