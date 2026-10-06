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
- `LOKI_IP` (optional): Loki host/IP for pushing logs, default `192.168.0.41`.
- `LOKI_PORT` (optional): Loki HTTP port, default `3100`.
- `LOKI_PROTOCOL` (optional): Loki protocol, default `http`.
- `LOKI_APP_LABEL` (optional): Loki `app` label value, default `alerts-tg-bot`.
- `LOKI_TIMEOUT_MS` (optional): Loki push timeout in milliseconds, default `2000`.

### Light Job Variables

- `LIGHT_QUEUE` (optional): queue number, `1..6`. Falls back to xbar-style `VAR_QUEUE`, then `5`.
- `LIGHT_SUB_QUEUE` (optional): subqueue number, `1..2`. Falls back to xbar-style `VAR_SUB_QUEUE`, then `1`.
- `LIGHT_TG_CHAT_ID` (optional): Telegram chat/channel for light notifications. Falls back to `TG_CHAT_ID`.
- `LIGHT_SUBSCRIPTIONS_FILE` (optional): path to a JSON file with queue/subqueue/chat subscriptions. When set, the light job fetches POE once and processes every subscription; `LIGHT_QUEUE`, `LIGHT_SUB_QUEUE`, and `LIGHT_TG_CHAT_ID` are used only by the single-queue mode and test commands.
- `LIGHT_POE_URL` (optional): POE HTML schedule URL. Default `https://www.poe.pl.ua/customs/dynamicgpv-info.php`. Plain HTTP is accepted only for localhost mock URLs.
- `LIGHT_MOCK_HOST` / `LIGHT_MOCK_PORT` (optional): host and port for `npm run start:light:mock`. Defaults to `127.0.0.1:3010`.
- `LIGHT_USE_STUB` (optional): if `true`, skips the POE GET request and reads HTML from `LIGHT_STUB_FILE`. Default `false`.
- `LIGHT_STUB_FILE` (optional): local HTML fixture for stub mode. Default `light-example.html`.
- `GEMINI_API_KEY` or `LIGHT_GEMINI_API_KEY` (optional): Gemini API key used to summarize what changed between old and new light segments.
- `LIGHT_GEMINI_ENABLED` (optional): enables Gemini summaries. If unset, Gemini is enabled automatically when an API key is present. Set it to `false` to disable summaries.
- `LIGHT_GEMINI_MODEL` (optional): Gemini model ID. Default `models/gemini-flash-lite-latest`.
- `LIGHT_GEMINI_API_BASE_URL` (optional): default `https://generativelanguage.googleapis.com/v1beta`.
- `LIGHT_GEMINI_TIMEOUT_MS`, `LIGHT_GEMINI_MAX_RETRIES`, `LIGHT_GEMINI_RETRY_BASE_DELAY_MS` (optional): Gemini request retry settings.
- `LIGHT_GEMINI_TEMPERATURE`, `LIGHT_GEMINI_MAX_OUTPUT_TOKENS` (optional): Gemini generation settings.
- `LIGHT_GEMINI_MIN_INTERVAL_MINUTES`, `LIGHT_GEMINI_MAX_DAILY_REQUESTS` (optional): multi-group Gemini request budget. Defaults to at most one request every 5 minutes and 20 requests in any rolling 24 hours. When the budget is reached, notifications still send with raw old/new schedules.
- `LIGHT_HTTP_TIMEOUT_MS`, `LIGHT_HTTP_MAX_RETRIES`, `LIGHT_HTTP_RETRY_BASE_DELAY_MS` (optional): light job HTTP retry settings; fall back to shared `HTTP_*` values.
- `LIGHT_TG_HTTP_TIMEOUT_MS`, `LIGHT_TG_HTTP_MAX_RETRIES`, `LIGHT_TG_HTTP_RETRY_BASE_DELAY_MS` (optional): light Telegram retry settings; fall back to shared `TG_HTTP_*` values.
- `LIGHT_LOCK_FILE_PATH` (optional): default `.light-job.lock`.
- `LIGHT_STATE_FILE_PATH` (optional): default `.light-last-state.json`.
- `LIGHT_ALWAYS_SEND_TG_MESSAGE` (optional): if `true`, sends a Telegram message on every run. Default `false`.
- `LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES` (optional): sends one reminder before each turn-off and turn-on transition when it starts in `N` minutes or less. Default `0` disables reminders. Reminder IDs include the date so the same time can notify again tomorrow.
- `LIGHT_CURRENT_MINUTE` (optional): override the local clock for a regular light run with an integer from `0` to `1439`; the live scenario command uses `--time HH:MM` instead.

### Local POE mock

`npm run start:light:mock` serves a horizontally scrolling 48-cell schedule builder for today and tomorrow, queues `1–6`, and subqueues `1–2`. Builder edits save automatically. The raw editor can replace exactly the HTML returned by `GET /customs/dynamicgpv-info.php`; “Load generated” copies the current builder output into the editor, and “Use schedule builder” switches the endpoint back to generated HTML. The mock still supports `POST /customs/search-disconnection.php` for compatibility, but the light worker does not call it. Changes take effect without restarting the server.

### Multiple queues and Telegram groups

Copy `light-subscriptions.example.json` to `light-subscriptions.json`, edit its entries, and set `LIGHT_SUBSCRIPTIONS_FILE=light-subscriptions.json` in `.env` or the light systemd service. Each entry has an integer `queue` (1–6), integer `subQueue` (1–2), and a string `chatId`. The same queue may appear for several chats; an identical queue/subqueue/chat entry is rejected. Keep `TG_BOT_TOKEN` in `.env`, not the JSON file. The local `light-subscriptions.json` file is ignored by Git.

`npm run start:light` remains the systemd command. With the subscriptions file configured, each run fetches the POE schedule once, evaluates each unique queue, and sends Telegram messages to the corresponding chats. Delivery state is saved per queue and chat. If one chat fails, other successful deliveries stay recorded, and only the failed chat retries on the next run. The first run in multi-group mode sends an initial schedule to every configured chat; the old single-queue state is not reused.

If Gemini is enabled, one batch request covers all changed queue schedules in that run, including queues followed by multiple chats. No Gemini call is made for unchanged schedules, reminders, or initial schedules without a previous version. Successful summaries are cached for the same schedule change and half-hour time slot. A failed or incomplete Gemini response falls back to the raw old/new schedule, with a 15-minute cooldown before another attempt for the same change. A rolling request budget defaults to at most one Gemini attempt every 5 minutes and 20 attempts per 24 hours; the cache keeps its 100 most recent entries. These safeguards reduce free-tier usage but cannot guarantee availability when the same Google project is used elsewhere.
The batch makes no immediate retry after a Gemini error; `LIGHT_GEMINI_MAX_RETRIES` still applies to the legacy single-queue path.

### Live light notification scenarios

Set `TG_BOT_TOKEN` and `LIGHT_TG_CHAT_ID` in `.env` to your **demo bot and group**. For schedule-change cases, also set `GEMINI_API_KEY` or `LIGHT_GEMINI_API_KEY`. These commands send real Telegram messages, and the schedule-change cases make real Gemini requests:

```sh
npm run test:light:live -- --list
npm run test:light:live -- --case initial
npm run test:light:live -- --case schedule-change
npm run test:light:live -- --case off-reminder --time 16:50
npm run test:light:live -- --case on-reminder --time 17:50
npm run test:light:live -- --case tentative-on --time 17:50
npm run test:light:live -- --case midnight-off --time 23:50
npm run test:light:live -- --case midnight-on --time 23:50
npm run test:light:live -- --case schedule-and-off --time 16:50
```

`--time HH:MM` sets the worker's current local clock time for the run. Each case has a default time shown by `--list`; `--lead N` changes the reminder window from the default 10 minutes. `--queue 1..6` and `--subqueue 1..2` select the queue shown in the message (defaults `5.1`). A reminder sends only if its transition falls after the selected time and within the lead window. `schedule-and-off` sends two messages. Each command starts a temporary local POE mock server, fetches its GET endpoint, and uses isolated state, so it does not change the mock builder at `127.0.0.1:3010` or the worker's saved state. The temporary mock URL in the message stops working when the command ends.

To fetch the **real POE schedule** and emulate the current local time, use:

```sh
npm run test:light:poe -- --time 16:50
npm run test:light:poe -- --time 17:50 --queue 5 --subqueue 1 --lead 20
npm run test:light:poe -- --time 23:50 --always
```

This command always calls the official POE schedule GET endpoint, even if `.env` points the regular worker at localhost. It sends real Telegram messages to `LIGHT_TG_CHAT_ID` (or `TG_CHAT_ID`). It keeps its own state in `.light-poe-test-state.json`, so the first run sends the current schedule and later runs send only changes or reminders within `--lead` minutes. `--always` also sends the schedule when it is unchanged. Choose a time just before a transition in the **actual POE schedule** to trigger a reminder; the examples alone do not guarantee one. With a Gemini API key configured, a later changed schedule makes a real Gemini request. The emulated time uses today's local date.

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
- `src/jobs/light/`: POE schedule job. Single-queue mode uses the configured queue/subqueue; multi-group mode uses a subscriptions JSON file and per-chat delivery state.

## Notes

- In legacy mode, successful API response is expected to be a single char: `N`, `A`, or `P`.
- In active endpoint mode (`ALERTS_USE_ACTIVE_ENDPOINT=true`), response is expected to be JSON with an `alerts` array. The worker emits `A` if at least one object matches:
  - `ALERTS_ACTIVE_MATCH_CRITERIA` (exact key/value matching).
  Otherwise it emits `N`.
- The first matching alert’s `alert_level` is stored as `alertLevel` and displayed as `🟡 Жовтий рівень` or `🔴 Червоний рівень`. Level changes also trigger notifications. Missing or unsupported levels omit the level line. The active endpoint mock (`response.json`) includes both levels.
- If both `ALERTS_USE_STUB=true` and `ALERTS_USE_ACTIVE_ENDPOINT=true`, stub data is loaded from `ALERTS_ACTIVE_STUB_FILE` instead of `ALERTS_STUB_RESPONSE`.
- For active development without consuming API limits, set `ALERTS_USE_STUB=true`.
- Notifications are sent via Telegram Bot API `sendMessage`.
- Notification is sent only when current state differs from the previously stored state.
- Set `ALWAYS_SEND_TG_MESSAGE=true` to bypass the diff check and notify on every run.
- Set `TREAT_P_AS_A=true` if your business rule requires treating partial alert (`P`) as full alert (`A`).
- The job uses a lock file to avoid overlapping runs.
- Logs are emitted as JSON lines for easier ingestion in production logging systems.
- Logs are persisted to `LOG_FILE_PATH` (default `alerts.log` in project root). The default `.gitignore` already excludes `*.log`.
- Logs are also buffered during a run and pushed to Loki after the job finishes at `LOKI_PROTOCOL://LOKI_IP:LOKI_PORT/loki/api/v1/push` with `app`, `level`, and `job` stream labels.
- The light job fetches the POE schedule with one GET request, parses today/tomorrow tables, and sends a Telegram message only when the selected queue/subqueue schedule fingerprint changes.
- For light job development without touching POE, set `LIGHT_USE_STUB=true`; by default it parses `light-example.html` from the project root.
- When Gemini is enabled, changed light notifications send normalized previous/current segments to Gemini using `models/{model}:generateContent` and display the returned summary above `Було` / `Стало`. If Gemini fails, the notification still sends with the raw old/new schedules.
- The light job also sends one reminder before each turn-off and turn-on transition when `LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES` is set. Sent reminders are persisted in `LIGHT_STATE_FILE_PATH` and keyed by date so they can recur on later days.
