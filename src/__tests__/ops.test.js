// src/__tests__/ops.test.js
// Owner ops alerts (ops.js, 2026-10): /ops/notify, /ops/subscribe,
// /ops/unsubscribe, the per-league cron health records, the self-alert,
// and their place on /health and /admin/health.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: vi.fn().mockResolvedValue('ok') }
})
vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveNHLSeason: vi.fn().mockResolvedValue(20262027),
    getAllPWHLSeasons: vi.fn().mockResolvedValue(null),
    getAllAHLSeasons: vi.fn().mockResolvedValue(null),
    getAllECHLSeasons: vi.fn().mockResolvedValue(null),
  }
})

import { handleRequest } from '../worker.js'
import { sendPush, recordHealth } from '../shared.js'
import { resolveNHLSeason, getAllPWHLSeasons, getAllAHLSeasons } from '../seasons.js'
import { notifyOps, trackCron, checkCronHealth, leagueInSeason, OPS_SUBS_KEY, CRON_STALE_MS } from '../ops.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

const WEB_SUB = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } }
const IOS_SUB = { platform: 'ios', token: 'a'.repeat(64) }

const notify = (env, body, secret = 'test-poll-secret') =>
  handleRequest(makeRequest(`/ops/notify?secret=${secret}`, { method: 'POST', body }), env, makeCtx())
const stored = async (env, key) => JSON.parse(await env.CACHE.get(key))
const asAdmin = () => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'matt@ehlers.io' }) })
  return { Authorization: 'Bearer owner-token' }
}

const realFetch = globalThis.fetch
beforeEach(() => { vi.clearAllMocks(); sendPush.mockResolvedValue('ok') })
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers() })

describe('POST /ops/notify', () => {
  it('401s without the secret, 405s on GET', async () => {
    const env = makeEnv()
    expect((await notify(env, { source: 'nightly.yml', status: 'failure', title: 'x' }, 'wrong')).status).toBe(401)
    const get = await handleRequest(makeRequest('/ops/notify?secret=test-poll-secret'), env, makeCtx())
    expect(get.status).toBe(405)
  })

  it('400s on a bad source, status or missing title', async () => {
    const env = makeEnv()
    expect((await notify(env, { source: 'a b', status: 'failure', title: 'x' })).status).toBe(400)
    expect((await notify(env, { source: 'nightly.yml', status: 'bad', title: 'x' })).status).toBe(400)
    expect((await notify(env, { source: 'nightly.yml', status: 'failure' })).status).toBe(400)
  })

  it('records health:ops:<source> without a TTL and pushes a failure to every ops subscriber', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB, IOS_SUB]))
    const put = vi.spyOn(env.CACHE, 'put')

    const res = await notify(env, {
      source: 'nightly.yml', status: 'failure', title: 'Nightly failed',
      body: 'https://github.com/run/1', url: 'https://github.com/run/1',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pushed: 2 })

    const rec = await stored(env, 'health:ops:nightly.yml')
    expect(rec).toMatchObject({ status: 'failure', title: 'Nightly failed', body: 'https://github.com/run/1', url: 'https://github.com/run/1' })
    expect(rec.at).toBeTruthy()
    expect(put.mock.calls.find(([k]) => k === 'health:ops:nightly.yml')[2]).toBeUndefined()
    expect(put.mock.calls.find(([k]) => k === 'ops:notified:nightly.yml')[2]).toEqual({ expirationTtl: 1800 })

    expect(sendPush).toHaveBeenCalledTimes(2)
    expect(sendPush.mock.calls[0][0]).toEqual(WEB_SUB)
    expect(sendPush.mock.calls[0][1]).toEqual({
      title: 'Nightly failed', body: 'https://github.com/run/1', tag: 'ops-nightly.yml', url: 'https://github.com/run/1',
    })
  })

  it('defaults the push url to /admin/health', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    await notify(env, { source: 'ahl-nightly.yml', status: 'warn', title: 'AHL nightly slow' })
    expect(sendPush.mock.calls[0][1].url).toBe('/admin/health')
  })

  it('pushes at most once per source per 30 min, but still records every report', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    await notify(env, { source: 'nightly.yml', status: 'failure', title: 'first' })
    const second = await notify(env, { source: 'nightly.yml', status: 'failure', title: 'second' })
    expect(await second.json()).toEqual({ ok: true, pushed: 0 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect((await stored(env, 'health:ops:nightly.yml')).title).toBe('second')

    // A different source isn't held back by it.
    await notify(env, { source: 'pwhl-nightly.yml', status: 'failure', title: 'pwhl' })
    expect(sendPush).toHaveBeenCalledTimes(2)
  })

  it('an ok report is recorded but never pushed', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    const res = await notify(env, { source: 'nightly.yml', status: 'ok', title: 'Nightly ok' })
    expect(await res.json()).toEqual({ ok: true, pushed: 0 })
    expect(sendPush).not.toHaveBeenCalled()
    expect((await stored(env, 'health:ops:nightly.yml')).status).toBe('ok')
  })

  it('drops subscriptions the push service says are gone', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB, IOS_SUB]))
    sendPush.mockImplementation(async sub => (sub.platform === 'ios' ? 'expired' : 'ok'))
    const res = await notify(env, { source: 'nightly.yml', status: 'failure', title: 'x' })
    expect(await res.json()).toEqual({ ok: true, pushed: 1 })
    expect(await stored(env, OPS_SUBS_KEY)).toEqual([WEB_SUB])
  })
})

describe('/ops/subscribe and /ops/unsubscribe', () => {
  it('401 without an owner session', async () => {
    const env = makeEnv()
    const res = await handleRequest(makeRequest('/ops/subscribe', { method: 'POST', body: WEB_SUB }), env, makeCtx())
    expect(res.status).toBe(401)
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ email: 'someone@example.com' }) })
    const other = await handleRequest(makeRequest('/ops/subscribe', {
      method: 'POST', body: WEB_SUB, headers: { Authorization: 'Bearer t' },
    }), env, makeCtx())
    expect(other.status).toBe(401)
  })

  it('upserts the /push/subscribe body by endpoint/token, keeping only what sending needs', async () => {
    const env = makeEnv()
    const headers = asAdmin()
    const sub = body => handleRequest(makeRequest('/ops/subscribe', { method: 'POST', body, headers }), env, makeCtx())

    let res = await sub({ ...WEB_SUB, teamAbbr: 'NHL:CAR', teams: [{ key: 'NHL:CAR', prefs: null }] })
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    res = await sub({ ...WEB_SUB, keys: { p256dh: 'p2', auth: 'a2' } })
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    res = await sub({ ...IOS_SUB, teamAbbr: 'NHL:CAR' })
    expect(await res.json()).toEqual({ ok: true, count: 2 })

    expect(await stored(env, OPS_SUBS_KEY)).toEqual([
      { endpoint: WEB_SUB.endpoint, keys: { p256dh: 'p2', auth: 'a2' } },
      IOS_SUB,
    ])
    // The app's team subscriptions are untouched.
    expect(await env.CACHE.get('push:subs')).toBeNull()
  })

  it('400s on a body with neither an https endpoint nor an iOS token', async () => {
    const env = makeEnv()
    const headers = asAdmin()
    const res = await handleRequest(makeRequest('/ops/subscribe', {
      method: 'POST', body: { endpoint: 'http://insecure.example.com' }, headers,
    }), env, makeCtx())
    expect(res.status).toBe(400)
  })

  it('unsubscribes by endpoint (POST) or token (DELETE)', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB, IOS_SUB]))
    const headers = asAdmin()
    let res = await handleRequest(makeRequest('/ops/unsubscribe', { method: 'POST', body: { endpoint: WEB_SUB.endpoint }, headers }), env, makeCtx())
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    res = await handleRequest(makeRequest('/ops/unsubscribe', { method: 'DELETE', body: { token: IOS_SUB.token }, headers }), env, makeCtx())
    expect(await res.json()).toEqual({ ok: true, count: 0 })
  })

  it('allows DELETE in CORS preflight responses', async () => {
    const res = await handleRequest(makeRequest('/ops/unsubscribe', { method: 'OPTIONS' }), makeEnv(), makeCtx())
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
  })
})

describe('trackCron', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })

  it('records lastPollAt and lastOkAt on success', async () => {
    vi.setSystemTime(new Date('2026-10-06T18:00:00Z'))
    const env = makeEnv()
    const rec = await trackCron(env, 'nhl', async () => {})
    expect(rec).toEqual({ lastPollAt: '2026-10-06T18:00:00.000Z', lastOkAt: '2026-10-06T18:00:00.000Z', lastError: null })
    expect(await stored(env, 'health:cron:nhl')).toEqual(rec)
  })

  it('never throws; a failure keeps the last success and records the error and when failing began', async () => {
    const env = makeEnv()
    vi.setSystemTime(new Date('2026-10-06T18:00:00Z'))
    await trackCron(env, 'ahl', async () => {})
    vi.setSystemTime(new Date('2026-10-06T18:01:00Z'))
    const first = await trackCron(env, 'ahl', async () => { throw new Error('Supabase 503') })
    vi.setSystemTime(new Date('2026-10-06T18:02:00Z'))
    const second = await trackCron(env, 'ahl', async () => { throw new Error('Supabase 504') })
    expect(first).toEqual({
      lastPollAt: '2026-10-06T18:01:00.000Z', lastOkAt: '2026-10-06T18:00:00.000Z',
      lastError: 'Supabase 503', failingSince: '2026-10-06T18:01:00.000Z',
    })
    expect(second).toMatchObject({ lastPollAt: '2026-10-06T18:02:00.000Z', lastOkAt: '2026-10-06T18:00:00.000Z', lastError: 'Supabase 504', failingSince: '2026-10-06T18:01:00.000Z' })
    vi.setSystemTime(new Date('2026-10-06T18:03:00Z'))
    expect(await trackCron(env, 'ahl', async () => {})).toMatchObject({ lastOkAt: '2026-10-06T18:03:00.000Z', lastError: null })
  })
})

describe('checkCronHealth (self-alert)', () => {
  const NOW = Date.parse('2026-12-01T18:00:00Z')
  const ok = iso => ({ lastPollAt: new Date(NOW).toISOString(), lastOkAt: iso, lastError: null })
  const failing = (lastOkAt, err = 'NHL 503') => ({ lastPollAt: new Date(NOW).toISOString(), lastOkAt, lastError: err, failingSince: lastOkAt })
  const ago = ms => new Date(NOW - ms).toISOString()

  it('alerts worker-cron-<league> once a league in season has had no good tick for 15 min', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    await checkCronHealth(env, { nhl: failing(ago(CRON_STALE_MS + 60000)), pwhl: ok(ago(0)) }, { now: NOW })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(sendPush.mock.calls[0][1]).toMatchObject({ title: 'NHL poller failing', tag: 'ops-worker-cron-nhl', url: '/admin/health' })
    expect(sendPush.mock.calls[0][1].body).toContain('NHL 503')
    expect((await stored(env, 'health:ops:worker-cron-nhl')).status).toBe('failure')

    // Debounced on the next tick.
    await checkCronHealth(env, { nhl: failing(ago(CRON_STALE_MS + 120000)) }, { now: NOW + 60000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for a failure younger than 15 min', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    await checkCronHealth(env, { nhl: failing(ago(CRON_STALE_MS - 60000)) }, { now: NOW })
    expect(sendPush).not.toHaveBeenCalled()
    expect(await env.CACHE.get('health:ops:worker-cron-nhl')).toBeNull()
  })

  it('stays quiet for a league out of season', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    resolveNHLSeason.mockResolvedValueOnce(20252026) // season over July 1, 2026
    await checkCronHealth(env, { nhl: failing(ago(CRON_STALE_MS * 4)) }, { now: Date.parse('2026-08-01T12:00:00Z') })
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('records the recovery once, without a push', async () => {
    const env = makeEnv()
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB]))
    await checkCronHealth(env, { ahl: failing(ago(CRON_STALE_MS * 2)) }, { now: NOW })
    expect(sendPush).toHaveBeenCalledTimes(1)
    await checkCronHealth(env, { ahl: ok(ago(0)) }, { now: NOW + 60000 })
    expect(sendPush).toHaveBeenCalledTimes(1)
    expect(await stored(env, 'health:ops:worker-cron-ahl')).toMatchObject({ status: 'ok', title: 'AHL poller recovered' })
  })
})

describe('leagueInSeason', () => {
  it('NHL: until July 1 of the resolved season end year', async () => {
    const env = makeEnv()
    resolveNHLSeason.mockResolvedValue(20252026)
    expect(await leagueInSeason(env, 'nhl', new Date('2026-06-20T00:00:00Z'))).toBe(true)
    expect(await leagueInSeason(env, 'nhl', new Date('2026-07-02T00:00:00Z'))).toBe(false)
    resolveNHLSeason.mockResolvedValue(20262027)
  })

  it('AHL/ECHL: inside a season start..end (+7 days); unknown counts as in season', async () => {
    const env = makeEnv()
    getAllAHLSeasons.mockResolvedValue([
      { seasonId: 90, seasonType: 'regular', startDate: '2025-10-10', endDate: '2026-04-19' },
      { seasonId: 92, seasonType: 'playoffs', startDate: '2026-04-22', endDate: '2026-06-10' },
    ])
    expect(await leagueInSeason(env, 'ahl', new Date('2026-06-15T12:00:00Z'))).toBe(true)
    expect(await leagueInSeason(env, 'ahl', new Date('2026-08-01T12:00:00Z'))).toBe(false)
    getAllAHLSeasons.mockResolvedValue(null)
    expect(await leagueInSeason(env, 'ahl', new Date('2026-08-01T12:00:00Z'))).toBe(true)
  })

  it('PWHL: within 220 days of a preseason or regular season start', async () => {
    const env = makeEnv()
    getAllPWHLSeasons.mockResolvedValue([
      { seasonId: 8, seasonType: 'regular', startDate: '2025-11-21' },
      { seasonId: 9, seasonType: 'playoffs', startDate: '2026-05-01' },
      { seasonId: 10, seasonType: 'preseason', startDate: '2026-11-15' },
    ])
    expect(await leagueInSeason(env, 'pwhl', new Date('2026-05-20T12:00:00Z'))).toBe(true)
    expect(await leagueInSeason(env, 'pwhl', new Date('2026-08-01T12:00:00Z'))).toBe(false)
    expect(await leagueInSeason(env, 'pwhl', new Date('2026-11-16T12:00:00Z'))).toBe(true)
    getAllPWHLSeasons.mockResolvedValue(null)
  })
})

describe('notifyOps', () => {
  it('returns pushed 0 with no subscribers', async () => {
    expect(await notifyOps(makeEnv(), { source: 's', status: 'failure', title: 't' })).toEqual({ ok: true, pushed: 0 })
  })
})

describe('/health and /admin/health', () => {
  it('/health carries every league\'s cron record and every ops report', async () => {
    const env = makeEnv()
    await trackCron(env, 'nhl', async () => {})
    await notifyOps(env, { source: 'nightly.yml', status: 'failure', title: 'Nightly failed' })
    // /health lives in nhl.js; go through the real dispatcher.
    const res = await handleRequest(makeRequest('/health'), env, makeCtx())
    const body = await res.json()
    expect(body.cron.nhl).toMatchObject({ lastError: null })
    expect(body.cron.lastOkAt).toBeUndefined()
    expect(Object.keys(body.cron)).toEqual(['nhl', 'pwhl', 'ahl', 'echl'])
    expect(body.ops['nightly.yml']).toMatchObject({ status: 'failure', title: 'Nightly failed' })
  })

  it('/admin/health keeps news sources separate and reports the ops subscriber count, not the subscriptions', async () => {
    const env = makeEnv()
    await recordHealth(env, 'pwhl:espn', true, { itemCount: 2 })
    await trackCron(env, 'pwhl', async () => {})
    await notifyOps(env, { source: 'ahl-nightly.yml', status: 'ok', title: 'ok' })
    await env.CACHE.put(OPS_SUBS_KEY, JSON.stringify([WEB_SUB, IOS_SUB]))
    const headers = asAdmin()
    const res = await handleRequest(makeRequest('/admin/health', { headers }), env, makeCtx())
    const body = await res.json()
    expect(body.sources.map(s => s.key)).toEqual(['pwhl:espn'])
    expect(body.cron.pwhl).toMatchObject({ lastError: null })
    expect(body.ops['ahl-nightly.yml'].status).toBe('ok')
    expect(body.opsSubscribers).toBe(2)
    expect(JSON.stringify(body)).not.toContain(WEB_SUB.endpoint)
  })
})
