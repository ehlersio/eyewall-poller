/**
 * ops.js — operational alerts for the app owner (2026-10)
 *
 * Nothing told the owner when something broke: pipeline "Notify on
 * failure" steps were `echo`s, and a cron tick that threw every minute for
 * days left /health saying ok:true (audit 2026-10-06 §4, §7). This module
 * is the one place failures are reported to:
 *
 *  - POST /ops/notify?secret=<POLL_SECRET>  — pipeline workflows (and the
 *    Worker itself) report { source, status, title, body?, url? }. The
 *    latest report per source is kept in `health:ops:<source>` (no TTL);
 *    a non-ok report pushes to every device in `ops:subs`, at most once
 *    per source per 30 min (`ops:notified:<source>`).
 *  - POST /ops/subscribe, POST|DELETE /ops/unsubscribe — owner-only
 *    (verifyAdminUser), same body the app sends to /push/subscribe.
 *  - `health:cron:<league>` — every poller's tick (trackCron), served on
 *    /health and /admin/health; checkCronHealth() alerts when a league in
 *    season hasn't completed a tick for CRON_STALE_MS.
 */

import { kvGet, kvPut, json, errorJson, badRequest, unauthorized, verifyAdminUser, sendPush, subId, nhlSeasonEnd } from './shared.js';
import { resolveNHLSeason, getAllPWHLSeasons, getAllAHLSeasons, getAllECHLSeasons } from './seasons.js';

export const OPS_SUBS_KEY = 'ops:subs';
const OPS_SUBS_TTL = 365 * 24 * 3600; // same as push:subs
export const OPS_DEBOUNCE_SECONDS = 30 * 60;
const OPS_DEFAULT_URL = '/admin/health';
const OPS_STATUSES = new Set(['failure', 'ok', 'warn']);
// Workflow file names (`nightly.yml`), `worker-cron-nhl`, `dispatch-<file>`.
const SOURCE_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const CRON_LEAGUES = ['nhl', 'pwhl', 'ahl', 'echl'];
export const CRON_STALE_MS = 15 * 60 * 1000;
const CRON_TTL = 30 * 24 * 3600; // rewritten every tick; only lapses if the cron stops entirely

const opsKey = source => `health:ops:${source}`;
const cronKey = league => `health:cron:${league}`;

// ── Notify ───────────────────────────────────────────────────

// Records `report` under health:ops:<source> and, unless it's an `ok`,
// pushes it to every ops subscriber -- once per source per 30 min.
// Returns { ok, pushed } where pushed counts successful sends.
export async function notifyOps(env, { source, status, title, body = '', url }, { send = sendPush } = {}) {
  const at = new Date().toISOString();
  const record = { status, title, body: body || '', url: url || null, at };
  await env.CACHE.put(opsKey(source), JSON.stringify(record)); // no TTL: last word per source stays
  if (status === 'ok') return { ok: true, pushed: 0 };

  const debounceKey = `ops:notified:${source}`;
  if (await env.CACHE.get(debounceKey)) return { ok: true, pushed: 0, debounced: true };
  await kvPut(env, debounceKey, at, OPS_DEBOUNCE_SECONDS);

  const subs = (await kvGet(env, OPS_SUBS_KEY)) || [];
  if (!subs.length) return { ok: true, pushed: 0 };
  const payload = { title, body: body || '', tag: `ops-${source}`, url: url || OPS_DEFAULT_URL };
  const results = await Promise.all(subs.map(s => send(s, payload, env)));

  const expired = new Set(subs.filter((_, i) => results[i] === 'expired').map(subId));
  if (expired.size) {
    const all = (await kvGet(env, OPS_SUBS_KEY)) || [];
    await kvPut(env, OPS_SUBS_KEY, all.filter(s => !expired.has(subId(s))), OPS_SUBS_TTL);
  }
  return { ok: true, pushed: results.filter(r => r === 'ok').length };
}

// The one stored device entry for a /push/subscribe-shaped body: only
// what sending needs (no teams/prefs -- ops alerts aren't team alerts).
function opsSubFromBody(body) {
  if (body?.platform === 'ios') {
    return typeof body.token === 'string' && /^[0-9a-fA-F]{32,200}$/.test(body.token)
      ? { platform: 'ios', token: body.token }
      : null;
  }
  if (typeof body?.endpoint !== 'string' || !body.endpoint.startsWith('https://')) return null;
  return { endpoint: body.endpoint, ...(body.keys ? { keys: body.keys } : {}) };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// /ops/* routes. Returns null for any other path.
export async function handleOps(request, env, url) {
  if (url.pathname === '/ops/notify') {
    if (request.method !== 'POST') return errorJson(405, { error: 'POST required' });
    if (!env.POLL_SECRET || url.searchParams.get('secret') !== env.POLL_SECRET) return unauthorized();
    const body = await readJson(request);
    if (!body || typeof body.source !== 'string' || !SOURCE_RE.test(body.source)) {
      return badRequest('source must be 1-100 letters, digits, . _ or -');
    }
    if (!OPS_STATUSES.has(body.status)) return badRequest('status must be failure, ok or warn');
    if (typeof body.title !== 'string' || !body.title.trim()) return badRequest('title is required');
    const result = await notifyOps(env, {
      source: body.source,
      status: body.status,
      title: body.title.slice(0, 200),
      body: typeof body.body === 'string' ? body.body.slice(0, 1000) : '',
      url: typeof body.url === 'string' ? body.url.slice(0, 500) : undefined,
    });
    return json({ ok: true, pushed: result.pushed });
  }

  if (url.pathname === '/ops/subscribe') {
    if (request.method !== 'POST') return errorJson(405, { error: 'POST required' });
    if (!(await verifyAdminUser(request, env))) return unauthorized();
    const sub = opsSubFromBody(await readJson(request));
    if (!sub) return badRequest('a web push endpoint or an iOS token is required');
    const subs = ((await kvGet(env, OPS_SUBS_KEY)) || []).filter(s => subId(s) !== subId(sub));
    subs.push(sub);
    await kvPut(env, OPS_SUBS_KEY, subs, OPS_SUBS_TTL);
    return json({ ok: true, count: subs.length });
  }

  if (url.pathname === '/ops/unsubscribe') {
    if (request.method !== 'POST' && request.method !== 'DELETE') return errorJson(405, { error: 'POST or DELETE required' });
    if (!(await verifyAdminUser(request, env))) return unauthorized();
    const body = await readJson(request);
    const id = body?.token || body?.endpoint;
    if (typeof id !== 'string' || !id) return badRequest('endpoint or token is required');
    const subs = ((await kvGet(env, OPS_SUBS_KEY)) || []).filter(s => subId(s) !== id);
    await kvPut(env, OPS_SUBS_KEY, subs, OPS_SUBS_TTL);
    return json({ ok: true, count: subs.length });
  }

  return null;
}

// ── Cron health ──────────────────────────────────────────────

// Runs one league's poll and records the tick in health:cron:<league>:
// lastPollAt always, lastOkAt on success, lastError (+ failingSince, the
// first failed tick since the last success) on a throw. Never throws, so
// one league's failure can't take the others down with it. Returns the
// record written.
export async function trackCron(env, league, fn) {
  const now = new Date().toISOString();
  let record;
  try {
    await fn();
    record = { lastPollAt: now, lastOkAt: now, lastError: null };
  } catch (e) {
    console.error(`${league.toUpperCase()} poll error:`, e?.message);
    const prev = (await kvGet(env, cronKey(league)).catch(() => null)) || {};
    record = {
      lastPollAt: now,
      lastOkAt: prev.lastOkAt || null,
      lastError: String(e?.message || e || 'unknown error').slice(0, 500),
      failingSince: prev.lastError ? (prev.failingSince || now) : now,
    };
  }
  await kvPut(env, cronKey(league), record, CRON_TTL).catch(e =>
    console.warn(`health:cron:${league} write failed: ${e.message}`)
  );
  return record;
}

export async function readCronHealth(env) {
  const records = await Promise.all(CRON_LEAGUES.map(l => kvGet(env, cronKey(l)).catch(() => null)));
  return Object.fromEntries(CRON_LEAGUES.map((l, i) => [l, records[i] || null]));
}

// Every health:ops:<source> record, keyed by source.
export async function readOpsHealth(env) {
  const list = await env.CACHE.list({ prefix: 'health:ops:' });
  const names = list.keys.map(k => k.name);
  const values = await Promise.all(names.map(n => kvGet(env, n).catch(() => null)));
  return Object.fromEntries(
    names.map((n, i) => [n.slice('health:ops:'.length), values[i]]).filter(([, v]) => v)
  );
}

// Is `league` in season today, by its own season dates rather than a
// calendar-month window? Only decides whether a failing poller is worth
// waking the owner for; an unknown answer counts as in season.
//  - NHL: until July 1 of the resolved season's end year (the poll's own
//    "season over" cutoff).
//  - AHL/ECHL: inside any season's start..end date (+7 days for a final
//    that runs past the listed end).
//  - PWHL: the bootstrap has no end dates; within 220 days of a preseason
//    or regular season's start (late November + 220 days is late June).
export async function leagueInSeason(env, league, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const daysFrom = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  try {
    if (league === 'nhl') return now.getTime() <= nhlSeasonEnd(await resolveNHLSeason(env)).getTime();
    if (league === 'pwhl') {
      const seasons = await getAllPWHLSeasons(env);
      if (!seasons) return true;
      return seasons.some(s => s.startDate && ['regular', 'preseason'].includes(s.seasonType)
        && s.startDate.slice(0, 10) <= today && daysFrom(s.startDate.slice(0, 10), 220) >= today);
    }
    const seasons = league === 'ahl' ? await getAllAHLSeasons(env) : await getAllECHLSeasons(env);
    if (!seasons) return true;
    return seasons.some(s => s.startDate && s.endDate
      && s.startDate <= today && daysFrom(s.endDate, 7) >= today);
  } catch {
    return true;
  }
}

// After the polls: any league in season whose last successful tick is
// older than CRON_STALE_MS gets a `worker-cron-<league>` failure (debounced
// by notifyOps); a league that has recovered gets an `ok` once, so the
// admin panel doesn't show a failure that has cleared.
export async function checkCronHealth(env, records, { now = Date.now(), send } = {}) {
  for (const league of CRON_LEAGUES) {
    const rec = records[league];
    if (!rec) continue;
    const source = `worker-cron-${league}`;
    const since = Date.parse(rec.lastOkAt || rec.failingSince || '') || now;
    const stale = rec.lastError && now - since > CRON_STALE_MS;
    if (stale) {
      if (!(await leagueInSeason(env, league, new Date(now)))) continue;
      const mins = Math.round((now - since) / 60000);
      await notifyOps(env, {
        source,
        status: 'failure',
        title: `${league.toUpperCase()} poller failing`,
        body: `No successful tick for ${mins} min. Last error: ${rec.lastError}`,
      }, send ? { send } : undefined);
    } else if (!rec.lastError) {
      const prev = await kvGet(env, opsKey(source)).catch(() => null);
      if (prev && prev.status !== 'ok') {
        await notifyOps(env, { source, status: 'ok', title: `${league.toUpperCase()} poller recovered` });
      }
    }
  }
}
