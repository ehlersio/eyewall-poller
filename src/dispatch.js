/**
 * dispatch.js — the Worker starts the pipeline's runs on time (2026-10)
 *
 * GitHub's `on: schedule` starts these workflows 3-7 hours late, and the
 * AI pipeline's morning predictions landed after afternoon puck drops
 * (audit 2026-10-06 §4). The Worker's own cron runs every minute on time,
 * so it triggers each workflow with a `workflow_dispatch` at its slot. The
 * workflows keep `on: schedule` as a fallback.
 *
 * Daily data workflows (one slot each): once the clock passes `atUTC`,
 * the first tick whose `ops:dispatched:<workflow>:<date>` marker is absent
 * POSTs the dispatch, and a 204 writes the marker (36h). A scheduled
 * fallback run skips itself when a run already succeeded that day.
 *
 * Social posts (social-posts.yml, 2026-10-15): one entry per post kind per
 * slot, sent with `inputs` ({kind, dry_run: 'false'}; the workflow's
 * dry_run defaults to true on a dispatch). Each kind has a first slot and
 * a backup an hour later, and each slot has its own marker
 * (`ops:dispatched:social-posts.yml:<kind>:<HH:MM>:<date>`), so the backup
 * dispatches even though the first did. `days` limits a slot to those UTC
 * weekdays (0 = Sunday, as cron). `windowMinutes` stops a slot from being
 * dispatched long after its time (after a Worker outage, or on deploy):
 * past it, the next slot or the GitHub fallback covers the post.
 * `spacingSeconds` holds the workflow's next dispatch back that long after
 * one is accepted, because its concurrency group keeps one run pending
 * and cancels it when another queues: slots that come due together go out
 * a few minutes apart instead. A fallback run finds the post already in
 * social_posts and exits.
 *
 * A failed dispatch is retried after DISPATCH_RETRY_SECONDS rather than
 * every minute. Each attempt is recorded in `health:ops:dispatch-<workflow>`
 * (`dispatch-social-posts.yml:<kind>` for posts), same shape as the
 * /ops/notify records.
 *
 * nhl-contracts (update-contracts.yml in ehlersio/nhl-contracts, 2026-10-23):
 * the open contracts dataset's collector runs hourly at :05 all year, and
 * every 15 minutes from July 1 to 15 (free agency opens July 1 and NHL.com's
 * Forge lists hold only 25 items, so a busy hour can overflow one). Each slot
 * has its own marker (`ops:dispatched:update-contracts.yml:<kind>:<HH:MM>:<date>`)
 * and a short window; `dates` limits the July slots to that span (UTC
 * MM-DD, inclusive). Entries carry a `repo` so the token must have Actions:
 * write on that repository too. That workflow keeps a daily GitHub cron as
 * its own fallback.
 *
 * Needs GITHUB_DISPATCH_TOKEN (a fine-grained PAT with Actions: write on
 * eyewall-pipeline and nhl-contracts). Without it this logs once a day and
 * does nothing.
 */

import { kvPut } from './shared.js';

export const DISPATCH_REPO = 'ehlersio/eyewall-pipeline';
export const DAILY_SCHEDULE = [
  { workflow: 'nightly.yml',          atUTC: '07:00' },
  { workflow: 'pwhl-nightly.yml',     atUTC: '07:20' },
  { workflow: 'ahl-nightly.yml',      atUTC: '07:40' },
  { workflow: 'echl-nightly.yml',     atUTC: '08:00' },
  { workflow: 'moneypuck-ingest.yml', atUTC: '10:00' },
  { workflow: 'ai_pipeline.yml',      atUTC: '14:00' },
];

// social-posts.yml, from the schedule comment at the top of that workflow
// (KEEP IN SYNC: a slot here with no matching cron there still posts; a
// cron there with no slot here posts late). `days` are UTC weekdays,
// 0 = Sunday; omitted = daily.
export const SOCIAL_WORKFLOW = 'social-posts.yml';
const SOCIAL_WINDOW_MINUTES = 45;  // the backup slot is 60 min after the first
const SOCIAL_SPACING_SECONDS = 5 * 60; // runs take under 3 min
const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5;
const SOCIAL_SLOTS = [
  // kind              first    backup   UTC weekdays
  ['rankings',       '15:00', '16:00', [MON]],
  ['winners',        '15:30', '16:30'],
  ['recap',          '18:00', '19:00', [MON]],
  ['leaders',        '17:00', '18:00', [TUE]],
  ['pwhl-winners',   '15:45', '16:45'],
  ['pwhl-recap',     '20:00', '21:00', [TUE]],
  ['minor-winners',  '16:15', '17:15'],
  ['minor-recap',    '17:00', '18:00', [WED]],
  ['pwhl-leaders',   '17:00', '18:00', [THU]],
  ['minor-leaders',  '21:00', '22:00', [THU]],
  ['minor-rankings', '17:30', '18:30', [MON]],
  ['pwhl-rankings',  '19:30', '20:30', [MON]],
  ['milk-carton',    '21:00', '22:00', [MON]],
  ['goal-of-week',   '17:00', '18:00', [FRI]],
  ['trends',         '15:00', '16:00', [FRI]],
  ['pwhl-trends',    '20:00', '21:00', [FRI]],
  ['minor-trends',   '22:00', '23:00', [FRI]],
  ['cherry-picked',  '15:00', '16:00', [SUN]],
];
const socialEntries = SOCIAL_SLOTS.flatMap(([kind, ...rest]) => {
  const days = Array.isArray(rest[rest.length - 1]) ? rest.pop() : undefined;
  return rest.map(atUTC => ({
    workflow: SOCIAL_WORKFLOW,
    atUTC,
    kind,
    inputs: { kind, dry_run: 'false' },
    ...(days && { days }),
    windowMinutes: SOCIAL_WINDOW_MINUTES,
    spacingSeconds: SOCIAL_SPACING_SECONDS,
  }));
}).sort((a, b) => a.atUTC.localeCompare(b.atUTC)); // catch-up goes earliest slot first

// update-contracts.yml in ehlersio/nhl-contracts: hourly at :05, plus :20,
// :35 and :50 from July 1 to 15 (UTC). `dates` is [from, to] as MM-DD.
export const CONTRACTS_REPO = 'ehlersio/nhl-contracts';
export const CONTRACTS_WORKFLOW = 'update-contracts.yml';
const CONTRACTS_JULY = ['07-01', '07-15'];
const hh = h => String(h).padStart(2, '0');
const contractsEntries = [
  ...Array.from({ length: 24 }, (_, h) => ({ atUTC: `${hh(h)}:05`, kind: 'hourly', windowMinutes: 30 })),
  ...Array.from({ length: 24 }, (_, h) => ['20', '35', '50'].map(mm => ({
    atUTC: `${hh(h)}:${mm}`, kind: 'july', windowMinutes: 10, dates: CONTRACTS_JULY,
  }))).flat(),
].map(e => ({ repo: CONTRACTS_REPO, workflow: CONTRACTS_WORKFLOW, ...e }));

export const DISPATCH_SCHEDULE = [...DAILY_SCHEDULE, ...socialEntries, ...contractsEntries];

const MARKER_TTL = 36 * 3600;
export const DISPATCH_RETRY_SECONDS = 10 * 60;

// The six daily workflows keep their original keys (`<workflow>:<date>`);
// a post's keys add its kind and slot.
const slotId = e => (e.kind ? `${e.workflow}:${e.kind}:${e.atUTC}` : e.workflow);
const markerKey = (e, date) => `ops:dispatched:${slotId(e)}:${date}`;
const retryKey = (e, date) => `ops:dispatch:retry:${slotId(e)}:${date}`;
const spacingKey = workflow => `ops:dispatch:spacing:${workflow}`;
const healthSource = e => `dispatch-${e.kind ? `${e.workflow}:${e.kind}` : e.workflow}`;
const label = e => (e.kind ? `${e.workflow} (${e.kind} ${e.atUTC})` : e.workflow);
const repoOf = e => e.repo || DISPATCH_REPO;
const workflowUrl = e => `https://github.com/${repoOf(e)}/actions/workflows/${e.workflow}`;
const dispatchUrl = e => `https://api.github.com/repos/${repoOf(e)}/actions/workflows/${e.workflow}/dispatches`;

const minutesOf = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const isDue = (e, hhmm, weekday, mmdd) => {
  if (e.days && !e.days.includes(weekday)) return false;
  if (e.dates && (mmdd < e.dates[0] || mmdd > e.dates[1])) return false;
  if (hhmm < e.atUTC) return false;
  return e.windowMinutes == null || minutesOf(hhmm) - minutesOf(e.atUTC) < e.windowMinutes;
};

async function record(env, e, status, title, body) {
  const rec = { status, title, body, url: workflowUrl(e), at: new Date().toISOString() };
  await env.CACHE.put(`health:ops:${healthSource(e)}`, JSON.stringify(rec)); // no TTL, as /ops/notify
}

// Called from scheduled() every tick. Returns what was dispatched this tick
// (for tests and logs): the workflow file, or `<workflow>:<kind>` for a post.
export async function maybeDispatchWorkflows(env, now = new Date()) {
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const hhmm = iso.slice(11, 16);
  const weekday = now.getUTCDay();
  const mmdd = iso.slice(5, 10);
  const due = DISPATCH_SCHEDULE.filter(e => isDue(e, hhmm, weekday, mmdd));
  if (!due.length) return [];

  const pending = [];
  for (const e of due) {
    if (await env.CACHE.get(markerKey(e, date))) continue;
    if (await env.CACHE.get(retryKey(e, date))) continue;
    pending.push(e);
  }
  if (!pending.length) return [];

  if (!env.GITHUB_DISPATCH_TOKEN) {
    const noTokenKey = `ops:dispatch:no-token:${date}`;
    if (!(await env.CACHE.get(noTokenKey))) {
      console.warn(`[dispatch] GITHUB_DISPATCH_TOKEN not set: not dispatching ${pending.map(label).join(', ')} (logged once a day)`);
      await kvPut(env, noTokenKey, true, MARKER_TTL);
    }
    return [];
  }

  const dispatched = [];
  const spaced = new Set(); // workflows held back by spacingSeconds this tick
  for (const e of pending) {
    const { workflow } = e;
    if (e.spacingSeconds) {
      if (spaced.has(workflow)) continue;
      if (await env.CACHE.get(spacingKey(workflow))) { spaced.add(workflow); continue; }
    }
    let status = 0;
    let detail = '';
    try {
      const res = await fetch(dispatchUrl(e), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'eyewall-poller',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(e.inputs ? { ref: 'main', inputs: e.inputs } : { ref: 'main' }),
      });
      status = res.status;
      if (status !== 204) detail = (await res.text().catch(() => '')).slice(0, 300);
    } catch (err) {
      detail = err.message;
    }

    if (status === 204) {
      await kvPut(env, markerKey(e, date), iso, MARKER_TTL);
      if (e.spacingSeconds) {
        await kvPut(env, spacingKey(workflow), iso, e.spacingSeconds);
        spaced.add(workflow);
      }
      await record(env, e, 'ok', `Dispatched ${label(e)}`, `Workflow dispatch accepted at ${iso}`);
      console.log(`[dispatch] ${label(e)} dispatched`);
      dispatched.push(e.kind ? `${workflow}:${e.kind}` : workflow);
    } else {
      await kvPut(env, retryKey(e, date), iso, DISPATCH_RETRY_SECONDS);
      await record(env, e, 'failure', `Dispatch of ${label(e)} failed`,
        `${status ? `GitHub ${status}` : 'Request failed'}${detail ? `: ${detail}` : ''}`);
      console.error(`[dispatch] ${label(e)} failed: ${status || ''} ${detail}`);
    }
  }
  return dispatched;
}
