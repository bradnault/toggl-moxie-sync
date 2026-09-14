# toggl-moxie-sync

Replaces the Toggl → Zapier → Moxie bridge with a small, reliable local job.
Reads your Toggl Track entries and creates matching Moxie time entries via
Moxie's Public API. Zero npm dependencies. Runs on the OpenClaw Air via launchd,
same as site-sentry / pm-notify.

## How it works

Every 3 hours: pull recent Toggl entries → for each completed entry, create a
Moxie time entry with the same client, project, note (your Toggl "Details"),
and start/end. Deduped by Toggl entry ID so nothing double-posts.

- **Billable is Moxie's call, not ours.** Moxie's create endpoint has no billable
  field; Moxie sets it from the client's project (hourly = billable, retainer /
  Signal Path = non-billable). Your Care Plan 0.5h inclusion and invoicing are
  untouched. WORK time under Signal Path still syncs (non-billable) so Moxie's
  Time dashboard keeps showing total tracked.
- **Names must match.** The Toggl client/project name has to match a Moxie
  client/project name (Moxie matches exactly). Anything that doesn't map is
  logged and skipped — never guessed — so you can fix the name and it syncs next
  run. (Same behavior as Zapier leaving unmatched time unassigned.)

## Setup on the Air

```bash
cd ~
git clone <this repo> toggl-moxie-sync   # or copy the folder over
cd toggl-moxie-sync
cp .env.example .env
open -e .env     # fill in TOGGL_API_TOKEN, MOXIE_BASE_URL, MOXIE_API_KEY

# 1) Dry run — logs what it WOULD create, writes nothing (SYNC_DRY_RUN=1 default)
node sync.js

# 2) Compare that output against what your Zap is creating in Moxie for a few days.
```

## Cutover (only after the dry run looks right)

1. In your `.env`, set `SYNC_ONLY_AFTER` to today's date (YYYY-MM-DD) so the sync
   won't re-create anything Zapier already made before the switch.
2. Turn OFF the Toggl → Moxie Zap.
3. Set `SYNC_DRY_RUN=0`.
4. `node sync.js` once to confirm live entries land correctly.
5. `./deploy/install-launchd.sh` to run it every 3 hours automatically.

## Env

- `TOGGL_API_TOKEN` — Toggl Track > Profile settings > API Token.
- `MOXIE_BASE_URL` — `https://<your-pod>.withmoxie.com/api/public`.
- `MOXIE_API_KEY` — Moxie > Settings > Apps & integrations > Custom Integration.
- `MOXIE_USER_EMAIL` — the Moxie workspace user the time belongs to.
- `SYNC_DRY_RUN` — `1` (default, safe) or `0` (live).
- `SYNC_LOOKBACK_DAYS` — days back to scan each run (default 10; overlap is fine).
- `SYNC_ONLY_AFTER` — set at cutover to avoid re-creating Zapier history.

## Useful

```bash
tail -f logs/toggl-moxie-sync.out.log
launchctl kickstart -k gui/$(id -u)/com.signalpath.toggl-moxie-sync   # run now
launchctl unload ~/Library/LaunchAgents/com.signalpath.toggl-moxie-sync.plist  # stop
```
