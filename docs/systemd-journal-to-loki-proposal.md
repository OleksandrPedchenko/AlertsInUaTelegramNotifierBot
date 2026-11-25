# Proposed systemd journal collection for the bot jobs

**Status:** follow-up proposal only. No collector, systemd unit, Grafana rule, or production configuration is changed by this document.

## Current setup and what must be confirmed

The Alerts and Light jobs are one-shot Node.js processes scheduled every minute in production. The repository documents `npm run start:light` as the Light systemd command, but does **not** contain the production `.service`/`.timer` files, their names, or the log collector configuration. Confirm those on the Proxmox LXC before applying the example below:

```sh
systemctl list-timers --all --no-pager
systemctl cat <alerts-service>.service <alerts-timer>.timer
systemctl cat <light-service>.service <light-timer>.timer
systemctl show <alerts-service>.service <light-service>.service \
  -p ExecStart -p WorkingDirectory -p User -p StandardOutput -p StandardError
systemctl status alloy --no-pager
journalctl -u <light-service>.service --since '1 hour ago' -o json --no-pager | head -5
```

Redact secrets if unit definitions or logs are shared. Identify the actual timer names, `OnCalendar`/`OnUnitActiveSec`, `AccuracySec`, `Persistent`, service type, stdout/stderr routing, and whether a collector already runs **inside the job LXC**. Also inspect a failed service run with `journalctl -u ... -o json` to see which journal fields identify systemd manager messages; they may differ from the fields on process stdout/stderr. Confirm that journald retains logs across reboot (`journalctl --disk-usage` and `/etc/systemd/journald.conf`).

Today, `src/lib/logger.js` writes each structured JSON line to the rotating `alerts.log`, writes it to stdout/stderr, and pushes it directly to Loki after the run. Existing Loki app streams use `app`, `level`, and sometimes `job` labels. The independent Grafana missing-success rules query those app streams. The repo contains no journal collector configuration. A fatal V8 crash, OS kill, or startup failure can occur before the logger's Loki flush, so the app stream alone cannot explain every missing run.

## Proposed collection path

1. Extend the collector on the **job LXC** if it already supports journald. If none exists there, evaluate the memory cost of a small Grafana Alloy instance before installing it in the 512 MB container. A collector on the Grafana/Loki machine cannot read the LXC's journal without an additional forwarding path.
2. Read only the two confirmed service units' journal entries. Preserve the original message text (including V8 fatal stderr) and add low-cardinality labels such as `source="systemd_journal"` and `unit="<actual-unit>"`. Do not put chat IDs, run IDs, PIDs, or exception text in labels.
3. Capture systemd manager failure/start/timeout messages separately if inspection shows they use `UNIT=<service>` or another field instead of `_SYSTEMD_UNIT=<service>`. Use the observed field in a separate, narrow journal source; do not assume a process-unit filter includes manager records.
4. Keep the app's direct Loki push and local JSONL rotation. Drop its normal structured JSON stdout/stderr from the journal pipeline so those lines are not ingested twice. Retain non-JSON fatal stderr, logger initialization/push failures, and systemd manager messages. The local JSONL file remains the fallback if a direct Loki push fails.
5. Do **not** add a broad `level="error"` label to the journal stream or include it in the existing error alert. The existing per-job missing-success alert remains the page for a silent stop; journal records provide the reason. Add a separate journal page only after checking that it gives useful earlier notice without duplicate Telegram notifications.

This duplicate filter has a deliberate tradeoff: if a process crashes before its buffered direct Loki push, its earlier structured JSON lines will remain in the local `alerts.log` but will not be recovered through the journal pipeline. The fatal stderr and systemd failure record should still arrive. If recovering all pre-crash app lines in Loki becomes a requirement, switch to one authoritative ingestion path for app JSON rather than sending it twice and trying to deduplicate in Loki.

### Example Alloy fragment

Replace the unit placeholders with the names found above. Merge these components into an existing Alloy config if present; do not start a second reader of the same journal entries. The `stage.drop` pattern matches this repository's JSON logger output, whose fields begin with `timestamp`, `level`, and `message`. Verify it against real stdout samples before use.

```alloy
loki.process "bot_journal" {
  forward_to = [loki.write.bot_journal.receiver]

  stage.drop {
    expression          = `^\{"timestamp":"[^"]+","level":"[^"]+","message":`
    drop_counter_reason = "already_pushed_by_app"
  }
}

loki.source.journal "alerts_service" {
  matches    = "_SYSTEMD_UNIT=<alerts-service>.service"
  labels     = { source = "systemd_journal", unit = "<alerts-service>.service" }
  forward_to = [loki.process.bot_journal.receiver]
}

loki.source.journal "light_service" {
  matches    = "_SYSTEMD_UNIT=<light-service>.service"
  labels     = { source = "systemd_journal", unit = "<light-service>.service" }
  forward_to = [loki.process.bot_journal.receiver]
}

loki.write "bot_journal" {
  endpoint {
    url = "http://192.168.0.41:3100/loki/api/v1/push"
  }
}
```

If inspection finds manager records with `UNIT=<light-service>.service`, add a separate `loki.source.journal` with that `matches` value and the same `source`/`unit` labels. Do the same for Alerts. Check sample journal records for overlap before adding it. Alloy's journal source automatically adds its own `job` label; use `unit` for the bot service name and keep these streams outside the app alert selectors.

The Alloy user needs journal read access (`adm` and `systemd-journal` groups in Grafana's documented setup). Limit the collector to the two units in its configuration even though journal access is broader. Review any existing Loki authentication rather than putting credentials in this repository. The example uses the current LAN Loki URL and assumes it is reachable from the LXC.

## Queries and alert candidates

Use actual `unit` label values and first verify the collected lines in Grafana Explore:

```logql
{source="systemd_journal",unit="<light-service>.service"} |~ "FATAL ERROR|heap out of memory|Allocation failed"
{source="systemd_journal",unit="<light-service>.service"} |~ "Failed with result|Main process exited|timed out|status=[1-9]"
sum by (unit) (count_over_time({source="systemd_journal"} |~ "FATAL ERROR|Allocation failed|Failed with result|Main process exited" [5m]))
```

The last query is an example **candidate**, not an enabled rule. Inspect real wording and eliminate noisy or duplicate matches first. If enabled, evaluate every minute with a five-minute window, `> 0` threshold, and direct `TG Notification` routing only after deciding how it should interact with the existing error and missing-success pages. Keep one paging path per incident; journal details can instead be linked from the missing-success alert runbook.

Kernel OOM kills may be logged only on the **Proxmox host**, not in the LXC's service journal. Check the guest and host journals for an actual OOM event before claiming host OOM coverage. Host kernel collection would require a separate, tightly scoped host-side source and permission review; it is outside this first rollout.

## Safe validation and rollback

1. Snapshot the collector config and confirm the app's existing Grafana error and missing-success alerts are Normal. Read a recent known service failure with `journalctl -u <unit> --since ...` and compare its raw fields with the proposed matches. Do not stop either production timer to create test data.
2. Validate the merged Alloy config with `alloy validate <config-path>` before restarting the collector. Check journal permissions, component health, and Loki write errors. Confirm a known existing stderr/manager line appears under `source="systemd_journal"`, while its structured app JSON appears only in the existing app stream.
3. Compare counts around one normal minute to catch duplicates. Verify the app error alert still matches only `{app=~"alerts-tg-bot|poe-notifier"}` and that both missing-success rules still see successful `job_performance` events. Keep any new journal alert disabled during this check.
4. Watch collector RSS, journal read rate, Loki ingestion, and disk use on the small LXC. If collection is noisy or expensive, restore the saved collector config and restart only the collector; the jobs and their direct Loki push continue independently.

References: [Grafana Alloy journal source](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/), [Alloy log processing](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.process/), [Alloy Loki writer](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/), [Alloy config validation](https://grafana.com/docs/alloy/latest/reference/cli/validate/), [systemd `journalctl`](https://www.freedesktop.org/software/systemd/man/latest/journalctl).
