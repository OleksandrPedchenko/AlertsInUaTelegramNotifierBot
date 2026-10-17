# Per-subscription light notification settings

## Intent and scope

Each Telegram chat subscribed to a queue may choose its own light-notification behavior. The same chat may choose different behavior for different queues. A subscription is identified by `(queue, subQueue, chatId)`, matching the existing state key. POE fetching, bot credentials, network retries, state and lock paths, logging, and the Gemini request budget remain shared by the job.

This change extends the open PR #7 (`feature/local-poe-change-summary`). It does not change the separate alerts job or the single-queue light mode.

## Subscription format

The queue-keyed file accepts a new `chats` array. Each entry has a nonempty string `chatId` and an optional `settings` object. Example:

```json
{
  "queues": {
    "6.1": {
      "enabled": true,
      "chats": [
        {
          "chatId": "CHAT_A",
          "settings": {
            "changeSummaryProvider": "local",
            "outageReminderBeforeMinutes": 10,
            "scheduleImageEnabled": true,
            "pinTodaySchedule": true,
            "treatYellowAsGreen": true
          }
        },
        {
          "chatId": "CHAT_B",
          "settings": {
            "changeSummaryProvider": "gemini",
            "outageReminderBeforeMinutes": 0,
            "scheduleImageEnabled": false
          }
        }
      ]
    }
  }
}
```

The allowed `settings` keys map directly to existing `LIGHT_*` behavior settings:

| JSON key | Existing environment default | Valid values |
| --- | --- | --- |
| `changeSummaryProvider` | `LIGHT_CHANGE_SUMMARY_PROVIDER` | `local`, `gemini` |
| `treatYellowAsGreen` | `LIGHT_TREAT_YELLOW_AS_GREEN` | boolean |
| `scheduleImageEnabled` | `LIGHT_SCHEDULE_IMAGE_ENABLED` | boolean |
| `pinTodaySchedule` | `LIGHT_PIN_TODAY_SCHEDULE` | boolean |
| `scheduleImageLayout` | `LIGHT_SCHEDULE_IMAGE_LAYOUT` | `horizontal`, `vertical` |
| `alwaysSendTgMessage` | `LIGHT_ALWAYS_SEND_TG_MESSAGE` | boolean |
| `outageReminderBeforeMinutes` | `LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES` | integer 0–1440 |

An omitted key inherits the loaded `.env` value, including its existing default. `settings: {}` has the same meaning as omitted `settings`. Reject unknown keys, incorrect types, out-of-range values, and duplicate queue–chat destinations before fetching POE or sending anything. Disabled queues still validate their structure and settings, but create no destinations. A queue entry uses either `chats` or legacy `chatIds`; reject both together to avoid ambiguous destinations.

Legacy queue `chatIds` arrays and the legacy top-level `subscriptions` array remain accepted. Both flatten into subscriptions with empty overrides. The top-level array may also contain a `settings` object per entry, allowing the same capability in that format. The existing single-queue environment mode is unchanged.

## Runtime behavior

Load and validate all destinations first. Load the shared configuration once, fetch POE once, and parse each distinct queue once. For each destination, merge only its behavior overrides into a shallow copy of the shared `job` configuration; leave the shared POE, Telegram transport, state, and logging objects untouched except for the existing queue and chat selection. Use this effective configuration throughout state construction, reminder selection, summary generation, notification rendering, pinning, and delivery.

The existing `light:<queue>.<subQueue>:chat:<chatId>` state key remains unchanged, so no state-file migration is needed. Changing presentation settings alone does not fabricate a POE schedule revision. Existing behavior for enabling pinning, changing reminder thresholds, and interpreting yellow periods continues independently for each subscription. Delivery failure for one destination does not prevent attempts for others, as today.

Gemini eligibility is evaluated per destination. A `gemini` subscription requires the shared Gemini API key unless Gemini is explicitly disabled globally; local subscriptions never call Gemini. Validate missing credentials before fetching POE or sending. If `LIGHT_GEMINI_ENABLED=false`, a subscription selecting `gemini` follows the current disabled-Gemini fallback (raw old/new schedules), and should not require a key. A global `gemini` default must not require a key when every enabled destination overrides it to `local`.

Keep one Gemini batch for eligible changed destinations and the existing shared request budget/cache. The batch prompt must carry each change's yellow interpretation instead of reading `items[0]`; mixed `treatYellowAsGreen` subscriptions must get accurate wording from the same request. Cache identity must include the effective interpretation wherever it can change the expected summary, so one chat cannot receive another chat's incompatible cached wording. A failed or budget-skipped Gemini request leaves each affected notification with its existing raw-schedule fallback. Local summaries remain deterministic per destination.

## Migration and documentation

Existing `light-subscriptions.json` files keep working unchanged. To customize one chat, replace that queue's `chatIds` with `chats`, preserving the same IDs and adding settings only where they differ. Update the example file and README with this pattern, precedence, shared settings, and validation rules. Keep the bot token and API key in `.env`, not in JSON.

## Verification

Use focused tests with fake POE and intercepted Telegram/Gemini requests, plus the existing full suite:

1. Legacy `chatIds`, legacy top-level array, and single-queue mode retain current behavior.
2. Two chats on one queue use different reminder, image, pin, yellow, and summary settings; their state keys remain distinct.
3. One chat on two queues can choose different settings without cross-contamination.
4. Omitted settings inherit `.env`; an explicit false or zero overrides a true or positive default.
5. Invalid/unknown settings, duplicate destinations, and mixed `chats`/`chatIds` fail before any POE or Telegram request.
6. Mixed local/Gemini destinations make Gemini requests only for eligible revisions. Mixed yellow modes yield accurate batch input and cache separation. Missing key and globally disabled Gemini take the documented paths.
7. One destination's delivery failure still permits the other destinations to run; reruns preserve notification and reminder state.
8. Live scenario tests can exercise per-subscription settings with mock POE and intercepted delivery before any optional real Telegram demonstration.

No real Telegram messages or Gemini calls are required to verify this feature in automated tests.
