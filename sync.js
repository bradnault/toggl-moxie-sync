// toggl-moxie-sync — replaces the fragile Toggl → Zapier → Moxie bridge.
//
// Reads your Toggl Track time entries via the Toggl API and creates matching
// Moxie time entries via Moxie's Public API (POST /action/timeWorked/create).
// Deterministic, zero npm dependencies, runs on the OpenClaw Air via launchd,
// same pattern as site-sentry / pm-notify.
//
// Design notes:
// - Billable rule: every entry syncs as billable EXCEPT the internal "WORK time"
//   project, which syncs non-billable. "Billable" just means available to
//   invoice; Brad decides what actually goes on each invoice in Moxie. WORK time
//   still syncs (non-billable) so Moxie's Time dashboard shows total tracked.
// - Names are passed through: the Toggl client/project name must match a Moxie
//   client/project name (Moxie requires exact match). Mismatches are logged, not
//   guessed. Fix the name on either side and it'll sync next run.
// - Dedupe: each synced Toggl entry id is remembered in data/synced-ids.json so
//   reruns never double-post.
// - SAFE BY DEFAULT: dry-run unless SYNC_DRY_RUN=0. Run it in parallel with your
//   existing Zap, confirm the logged output matches, THEN set SYNC_ONLY_AFTER to
//   the cutover date, turn the Zap off, and flip SYNC_DRY_RUN=0.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ---------- config ---------- */
function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* rely on real env */ }
}
loadEnv();

const TOGGL_TOKEN = process.env.TOGGL_API_TOKEN;
const MOXIE_BASE = (process.env.MOXIE_BASE_URL || '').replace(/\/+$/, ''); // e.g. https://podNN.withmoxie.com/api/public
const MOXIE_KEY = process.env.MOXIE_API_KEY;
const MOXIE_USER_EMAIL = process.env.MOXIE_USER_EMAIL || 'brad@signalpathcreative.com';
const DRY_RUN = process.env.SYNC_DRY_RUN !== '0'; // default TRUE (safe)
const LOOKBACK_DAYS = parseInt(process.env.SYNC_LOOKBACK_DAYS || '10', 10);
const ONLY_AFTER = process.env.SYNC_ONLY_AFTER || ''; // ISO date; skip entries starting before this (dupe guard at cutover)

function fail(m) { console.error(`[toggl-moxie] ${m}`); process.exit(1); }
if (!TOGGL_TOKEN) fail('TOGGL_API_TOKEN not set.');
if (!DRY_RUN && (!MOXIE_BASE || !MOXIE_KEY)) fail('MOXIE_BASE_URL and MOXIE_API_KEY required for live mode.');

const DATA_DIR = join(__dirname, 'data');
const SEEN_FILE = join(DATA_DIR, 'synced-ids.json');
function loadSeen() { try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))); } catch { return new Set(); } }
function saveSeen(set) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SEEN_FILE, JSON.stringify([...set], null, 0)); }

/* ---------- Toggl ---------- */
const TOGGL_AUTH = 'Basic ' + Buffer.from(`${TOGGL_TOKEN}:api_token`).toString('base64');
async function toggl(path) {
  const r = await fetch('https://api.track.toggl.com/api/v9' + path, { headers: { Authorization: TOGGL_AUTH, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`Toggl ${path} -> HTTP ${r.status} ${await r.text().catch(() => '')}`);
  return r.json();
}
function ymd(d) { return d.toISOString().slice(0, 10); }

/* ---------- Moxie ---------- */
async function moxieCreateTimeEntry(body) {
  const r = await fetch(MOXIE_BASE + '/action/timeWorked/create', {
    method: 'POST',
    headers: { 'X-API-KEY': MOXIE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Moxie create -> HTTP ${r.status} ${await r.text().catch(() => '')}`);
  return r.json().catch(() => ({}));
}

async function main() {
  console.log(`[toggl-moxie] ${DRY_RUN ? 'DRY RUN' : 'LIVE'} — lookback ${LOOKBACK_DAYS}d${ONLY_AFTER ? `, only after ${ONLY_AFTER}` : ''}`);

  // Names: pull clients + projects once for id -> name resolution.
  const me = await toggl('/me?with_related_data=true');
  const clientById = new Map((me.clients || []).map((c) => [c.id, c.name]));
  const projectById = new Map((me.projects || []).map((p) => [p.id, p]));

  const start = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const end = new Date(Date.now() + 86400000);
  const entries = await toggl(`/me/time_entries?start_date=${ymd(start)}&end_date=${ymd(end)}`);

  const seen = loadSeen();
  let created = 0, skipped = 0, mismatched = 0, already = 0;

  for (const e of entries) {
    const id = String(e.id);
    if (e.stop == null || e.duration < 0) { continue; } // running timer — skip until stopped
    if (seen.has(id)) { already++; continue; }
    if (ONLY_AFTER && e.start < ONLY_AFTER) { continue; } // cutover dupe guard

    const proj = e.project_id ? projectById.get(e.project_id) : null;
    const projectName = proj ? proj.name : null;
    const clientName = proj && proj.client_id ? clientById.get(proj.client_id) : (e.client_id ? clientById.get(e.client_id) : null);

    if (!clientName || !projectName) {
      console.warn(`[skip] ${id} "${e.description || ''}" — no ${!clientName ? 'client' : 'project'} mapping (Toggl proj ${e.project_id || 'none'}). Left for you to categorize, like Zapier does.`);
      mismatched++; continue;
    }

    // Rule: everything billable EXCEPT the internal "WORK time" project.
    // "Billable" just means available to invoice; Brad decides what to actually
    // bill when building invoices in Moxie.
    const billable = (projectName || '').trim().toLowerCase() !== 'work time';
    const tag = billable ? 'billable' : 'non-billable';
    const body = {
      timerStart: e.start,
      timerEnd: e.stop,
      clientName,
      projectName,
      notes: e.description || '',
      userEmail: MOXIE_USER_EMAIL,
      billable,
    };

    if (DRY_RUN) {
      console.log(`[dry] would create: ${clientName} / ${projectName} | ${(e.duration / 3600).toFixed(2)}h | ${tag} | "${e.description || ''}"`);
      skipped++;
      continue;
    }
    try {
      await moxieCreateTimeEntry(body);
      seen.add(id);
      created++;
      console.log(`[sent] ${clientName} / ${projectName} | ${(e.duration / 3600).toFixed(2)}h | ${tag} | "${e.description || ''}"`);
    } catch (err) {
      console.error(`[FAIL] ${id}: ${err.message}`); // leave unseen -> retries next run
    }
  }

  if (!DRY_RUN && created) saveSeen(seen);
  console.log(`[toggl-moxie] done. ${DRY_RUN ? `would-create ${skipped}` : `created ${created}`}, already-synced ${already}, unmapped ${mismatched}, of ${entries.length} entries.`);
}

main().catch((e) => fail(e.message));
