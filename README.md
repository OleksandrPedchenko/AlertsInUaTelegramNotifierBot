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

   This runs the dedicated alerts cron entrypoint at `src/jobs/alerts/index.js`.

   Run the light queue job manually:
   ```bash
   npm run start:light
   ```

   Run the editable light mock server:
   ```bash
   npm run start:light:mock
   ```

   Open `http://127.0.0.1:3010/` to edit the schedule or the exact HTML returned by the mock. Point the worker at the mock with:
   ```env
   LIGHT_POE_URL=http://127.0.0.1:3010/customs/dynamicgpv-info.php
   LIGHT_POE_POST_URL=http://127.0.0.1:3010/customs/search-disconnection.php
   ```

4. Run tests:
   ```bash
   npm test
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
- `LOG_FILE_PATH` (optional): JSON-lines log file path (resolved from project root), default `alerts.log`.
- `LOG_RETENTION_DAYS` (optional): keeps only log entries newer than `N` days in `LOG_FILE_PATH` (`0` disables trimming), default `7`.

### Light Job Variables

- `LIGHT_QUEUE` (optional): queue number, `1..6`. Falls back to xbar-style `VAR_QUEUE`, then `5`.
- `LIGHT_SUB_QUEUE` (optional): subqueue number, `1..2`. Falls back to xbar-style `VAR_SUB_QUEUE`, then `1`.
- `LIGHT_TG_CHAT_ID` (optional): Telegram chat/channel for light notifications. Falls back to `TG_CHAT_ID`.
- `LIGHT_POE_URL` (optional): POE HTML schedule URL. Default `https://www.poe.pl.ua/customs/dynamicgpv-info.php`.
- `LIGHT_POE_POST_URL` (optional): POE disconnection search URL. Default `https://www.poe.pl.ua/customs/search-disconnection.php`.
- `LIGHT_MOCK_HOST` / `LIGHT_MOCK_PORT` (optional): host and port for `npm run start:light:mock`. Defaults to `127.0.0.1:3010`.
- `LIGHT_POST_BODY_JSON` (optional): JSON body encoded as `disconn=...` for the POE POST request. Defaults to the same address payload from the xbar script.
- `LIGHT_USE_STUB` (optional): if `true`, skips POE GET/POST requests and reads HTML from `LIGHT_STUB_FILE`. Default `false`.
- `LIGHT_STUB_FILE` (optional): local HTML fixture for stub mode. Default `light-example.html`.
- `GEMINI_API_KEY` or `LIGHT_GEMINI_API_KEY` (optional): Gemini API key used to summarize what changed between old and new light segments.
- `LIGHT_GEMINI_ENABLED` (optional): enables Gemini summaries. If unset, Gemini is enabled automatically when an API key is present. Default in `.env.example` is `false` to avoid accidental API usage.
- `LIGHT_GEMINI_MODEL` (optional): Gemini model ID. Default `models/gemini-flash-lite-latest`.
- `LIGHT_GEMINI_API_BASE_URL` (optional): default `https://generativelanguage.googleapis.com/v1beta`.
- `LIGHT_GEMINI_TIMEOUT_MS`, `LIGHT_GEMINI_MAX_RETRIES`, `LIGHT_GEMINI_RETRY_BASE_DELAY_MS` (optional): Gemini request retry settings.
- `LIGHT_GEMINI_TEMPERATURE`, `LIGHT_GEMINI_MAX_OUTPUT_TOKENS` (optional): Gemini generation settings.
- `LIGHT_HTTP_TIMEOUT_MS`, `LIGHT_HTTP_MAX_RETRIES`, `LIGHT_HTTP_RETRY_BASE_DELAY_MS` (optional): light job HTTP retry settings; fall back to shared `HTTP_*` values.
- `LIGHT_TG_HTTP_TIMEOUT_MS`, `LIGHT_TG_HTTP_MAX_RETRIES`, `LIGHT_TG_HTTP_RETRY_BASE_DELAY_MS` (optional): light Telegram retry settings; fall back to shared `TG_HTTP_*` values.
- `LIGHT_LOCK_FILE_PATH` (optional): default `.light-job.lock`.
- `LIGHT_STATE_FILE_PATH` (optional): default `.light-last-state.json`.
- `LIGHT_ALWAYS_SEND_TG_MESSAGE` (optional): if `true`, sends a Telegram message on every run. Default `false`.
- `LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES` (optional): sends a one-time reminder when today’s next outage starts in `N` minutes or less. Default `0` disables reminders.

## Cron Setup (Every N Minutes)

Use system cron to execute this one-shot script every `N` minutes.

Example for every `5` minutes:

```cron
*/5 * * * * cd /Users/olexandrpedchenko/projects/AlertsTgBot && /usr/bin/env node src/jobs/alerts/index.js
```

Example light job every minute:

```cron
* * * * * cd /Users/olexandrpedchenko/projects/AlertsTgBot && /usr/bin/env node src/jobs/light/index.js
```

## Project Layout

- `src/lib/`: shared one-shot job runner, lock, logger, config readers, HTTP retry client, Telegram sender, and keyed JSON state store.
- `src/jobs/alerts/`: alert-specific config, API parsing, state fingerprinting, and Telegram message text.
- `src/jobs/light/`: POE queue/subqueue schedule job. Its state key is the configured `LIGHT_QUEUE` + `LIGHT_SUB_QUEUE`.

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
- Logs are persisted to `LOG_FILE_PATH` (default `alerts.log` in project root). The default `.gitignore` already excludes `*.log`.
- The light job fetches both POE endpoints from the xbar script, parses today/tomorrow tables, and sends a Telegram message only when the selected queue/subqueue schedule fingerprint changes.
- For light job development without touching POE, set `LIGHT_USE_STUB=true`; by default it parses `light-example.html` from the project root.
- When Gemini is enabled, changed light notifications send normalized previous/current segments to Gemini using `models/{model}:generateContent` and display the returned summary above `Було` / `Стало`. If Gemini fails, the notification still sends with the raw old/new schedules.
- The light job can also send a separate one-time outage reminder with `LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES`, for example when an outage starts within the next 10 minutes. Sent reminders are persisted in `LIGHT_STATE_FILE_PATH` so cron does not repeat them every run.
