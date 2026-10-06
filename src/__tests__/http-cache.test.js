// Cache-Control + ETag on every GET JSON response (shared.js's
// withHttpCache(), 2026-10). Before, only /alerts/recent sent a
// Cache-Control, so every page load re-downloaded every read in full
// (audit 2026-10-06 §5 / app-perf 1.7).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleRequest } from '../worker.js'
import { cacheControl, isLivePath, weakEtag, MAX_MAX_AGE, LIVE_MAX_AGE, DEFAULT_MAX_AGE } from '../shared.js'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }))
})
afterEach(() => { globalThis.fetch = realFetch })

const get = (path, env, headers) => handleRequest(makeRequest(path, { headers }), env, makeCtx())

describe('helpers', () => {
  it('cacheControl caps max-age at an hour and floors it at 0', () => {
    expect(cacheControl(60)).toBe('public, max-age=60')
    expect(cacheControl(24 * 3600)).toBe(`public, max-age=${MAX_MAX_AGE}`)
    expect(cacheControl(0)).toBe('public, max-age=0')
    expect(cacheControl(-5)).toBe('public, max-age=0')
  })

  it('isLivePath covers the live-game routes, encoded or not', () => {
    for (const p of ['/nhl/today', '/pwhl/today', '/ahl/today', '/echl/live/123', '/pwhl/live/9',
      '/ahl/schedule', '/cache/pbp:2025020001', '/cache/boxscore%3A2025020001', '/cache/schedule%3ACAR%3A20262027']) {
      expect(isLivePath(p)).toBe(true)
    }
    for (const p of ['/schedule', '/pwhl/standings', '/cache/standings', '/roster', '/cache/summary:1']) {
      expect(isLivePath(p)).toBe(false)
    }
  })

  it('weakEtag is a stable weak validator of the body', async () => {
    const a = await weakEtag('{"a":1}')
    expect(a).toMatch(/^W\/"[0-9a-f]{40}"$/)
    expect(await weakEtag('{"a":1}')).toBe(a)
    expect(await weakEtag('{"a":2}')).not.toBe(a)
  })
})

describe('GET responses', () => {
  it('a KV-backed route sends max-age = its KV TTL and an ETag', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:seasons:comparison': { nhl: { seasons: [] } } }) })
    const res = await get('/config/seasons/comparison', env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(res.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{40}"$/)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(await res.json()).toEqual({ nhl: { seasons: [] } })
  })

  it('a longer KV TTL is capped at an hour (/players-search-index keeps 6 hr in KV)', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'players-search-index': [{ id: 1 }] }) })
    const res = await get('/players-search-index', env)
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${MAX_MAX_AGE}`)
  })

  it('/nhl/today is held for LIVE_MAX_AGE, not its 60 s KV TTL', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'nhl:today': [{ id: 2025020001 }] }) })
    const res = await get('/nhl/today', env)
    expect(res.status).toBe(200)
    expect(LIVE_MAX_AGE).toBeLessThanOrEqual(30)
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${LIVE_MAX_AGE}`)
    expect(res.headers.get('ETag')).toBeTruthy()
  })

  it('a live /cache/ read (encoded key, no KV TTL known) is held for LIVE_MAX_AGE', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'pbp:2025020001': { plays: [] } }) })
    const res = await get('/cache/pbp%3A2025020001', env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${LIVE_MAX_AGE}`)
  })

  it('a route with no KV cache of its own gets the 30 s default', async () => {
    const res = await get('/health', makeEnv())
    expect(res.status).toBe(200)
    expect(DEFAULT_MAX_AGE).toBe(30)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
  })

  it('/alerts/recent keeps its own header', async () => {
    const res = await get('/alerts/recent?teams=NHL:CAR', makeEnv())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30')
    expect(res.headers.get('ETag')).toBeTruthy()
  })

  it('answers a matching If-None-Match with a bodiless 304', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:seasons:comparison': { nhl: { seasons: [1] } } }) })
    const first = await get('/config/seasons/comparison', env)
    const etag = first.headers.get('ETag')

    const again = await get('/config/seasons/comparison', env, { 'If-None-Match': etag })
    expect(again.status).toBe(304)
    expect(again.body).toBeNull()
    expect(again.headers.get('ETag')).toBe(etag)
    expect(again.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(again.headers.get('Access-Control-Allow-Origin')).toBe('*')

    // Weak comparison: the strong form of the same tag matches too.
    const strong = await get('/config/seasons/comparison', env, { 'If-None-Match': `"other", ${etag.slice(2)}` })
    expect(strong.status).toBe(304)

    const changed = await get('/config/seasons/comparison', env, { 'If-None-Match': 'W/"stale"' })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({ nhl: { seasons: [1] } })
  })
})

describe('no-store', () => {
  it('on a POST', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'push:subs': [] }) })
    const res = await handleRequest(
      makeRequest('/push/unsubscribe', { method: 'POST', body: { endpoint: 'https://push.example/x' } }), env, makeCtx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('ETag')).toBeNull()
  })

  it('on a 4xx', async () => {
    const forbidden = await get('/cache/push:subs', makeEnv())
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('Cache-Control')).toBe('no-store')

    const bad = await get('/alerts/recent', makeEnv())
    expect(bad.status).toBe(400)
    expect(bad.headers.get('Cache-Control')).toBe('no-store')

    const badParam = await get('/game-log?team=CAR&season=2025%26x', makeEnv())
    expect(badParam.status).toBe(400)
    expect(badParam.headers.get('Cache-Control')).toBe('no-store')
  })

  it('on a 5xx', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }))
    const res = await get('/config/seasons/ahl-seasons', makeEnv())
    expect(res.status).toBe(502)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('on an owner GET (secret=) and an Authorization-bearing one', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ standings: [{ teamAbbrev: { default: 'CAR' } }] }) })
    const res = await get('/cache/standings?secret=test-poll-secret', env)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const authed = await get('/cache/standings', env, { Authorization: 'Bearer x' })
    expect(authed.headers.get('Cache-Control')).toBe('no-store')
  })

  it('leaves the CORS preflight alone', async () => {
    const res = await handleRequest(makeRequest('/roster', { method: 'OPTIONS' }), makeEnv(), makeCtx())
    expect(res.status).toBe(204)
    expect(res.headers.get('Cache-Control')).toBeNull()
  })
})
