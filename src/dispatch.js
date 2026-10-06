/**
 * dispatch.js — the Worker starts the pipeline's daily runs (2026-10)
 *
 * GitHub's `on: schedule` starts these workflows 3-7 hours late, and the
 * AI pipeline's morning predictions landed after afternoon puck drops
 * (audit 2026-10-06 §4). The Worker's own cron runs every minute on time,
 * so it triggers each workflow with a `workflow_dispatch` once a day at
 * its slot. The workflows keep `on: schedule` as a fallback, and a
 * scheduled run skips itself when a run already succeeded that day.
 *
 * Per workflow per UTC day: once the clock passes `atUTC`, the first tick
 * whose `ops:dispatched:<workflow>:<date>` marker is absent POSTs the
 * dispatch, and a 204 writes the marker (36h). A failed dispatch is
 * retried after DISPATCH_RETRY_SECONDS rather than every minute. Each
 * attempt is recorded in `health:ops:dispatch-<workflow>`, same shape as
 * the /ops/notify records.
 *
 * Needs GITHUB_DISPATCH_TOKEN (a fine-grained PAT with Actions: write on
 * eyewall-pipeline). Without it this logs once a day and does nothing.
 */

import { kvPut } from './shared.js';

export const DISPATCH_REPO = 'ehlersio/eyewall-pipeline';
export const DISPATCH_SCHEDULE = [
  { workflow: 'nightly.yml',          atUTC: '07:00' },
  { workflow: 'pwhl-nightly.yml',     atUTC: '07:20' },
  { workflow: 'ahl-nightly.yml',      atUTC: '07:40' },
  { workflow: 'echl-nightly.yml',     atUTC: '08:00' },
  { workflow: 'moneypuck-ingest.yml', atUTC: '10:00' },
  { workflow: 'ai_pipeline.yml',      atUTC: '14:00' },
];
const MARKER_TTL = 36 * 3600;
export const DISPATCH_RETRY_SECONDS = 10 * 60;

const markerKey = (workflow, date) => `ops:dispatched:${workflow}:${date}`;
const retryKey = (workflow, date) => `ops:dispatch:retry:${workflow}:${date}`;
const workflowUrl = workflow => `https://github.com/${DISPATCH_REPO}/actions/workflows/${workflow}`;

async function record(env, workflow, status, title, body) {
  const rec = { status, title, body, url: workflowUrl(workflow), at: new Date().toISOString() };
  await env.CACHE.put(`health:ops:dispatch-${workflow}`, JSON.stringify(rec)); // no TTL, as /ops/notify
}

// Called from scheduled() every tick. Returns the workflows dispatched
// this tick (for tests and logs).
export async function maybeDispatchWorkflows(env, now = new Date()) {
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const hhmm = iso.slice(11, 16);
  const due = DISPATCH_SCHEDULE.filter(e => hhmm >= e.atUTC);
  if (!due.length) return [];

  const pending = [];
  for (const e of due) {
    if (await env.CACHE.get(markerKey(e.workflow, date))) continue;
    if (await env.CACHE.get(retryKey(e.workflow, date))) continue;
    pending.push(e);
  }
  if (!pending.length) return [];

  if (!env.GITHUB_DISPATCH_TOKEN) {
    const noTokenKey = `ops:dispatch:no-token:${date}`;
    if (!(await env.CACHE.get(noTokenKey))) {
      console.warn(`[dispatch] GITHUB_DISPATCH_TOKEN not set: not dispatching ${pending.map(e => e.workflow).join(', ')} (logged once a day)`);
      await kvPut(env, noTokenKey, true, MARKER_TTL);
    }
    return [];
  }

  const dispatched = [];
  for (const { workflow } of pending) {
    let status = 0;
    let detail = '';
    try {
      const res = await fetch(`https://api.github.com/repos/${DISPATCH_REPO}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'eyewall-poller',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      });
      status = res.status;
      if (status !== 204) detail = (await res.text().catch(() => '')).slice(0, 300);
    } catch (e) {
      detail = e.message;
    }

    if (status === 204) {
      await kvPut(env, markerKey(workflow, date), iso, MARKER_TTL);
      await record(env, workflow, 'ok', `Dispatched ${workflow}`, `Workflow dispatch accepted at ${iso}`);
      console.log(`[dispatch] ${workflow} dispatched`);
      dispatched.push(workflow);
    } else {
      await kvPut(env, retryKey(workflow, date), iso, DISPATCH_RETRY_SECONDS);
      await record(env, workflow, 'failure', `Dispatch of ${workflow} failed`,
        `${status ? `GitHub ${status}` : 'Request failed'}${detail ? `: ${detail}` : ''}`);
      console.error(`[dispatch] ${workflow} failed: ${status || ''} ${detail}`);
    }
  }
  return dispatched;
}
