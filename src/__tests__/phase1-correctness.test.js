// src/__tests__/phase1-correctness.test.js
// Small correctness fixes (Phase 1, W4, 2026-10): the shared Eastern date,
// /game-log's gameType, /nhl/shots' paging order, /pp-units/refresh's
// reply, and the AI routes' cache-before-rate-limit, timeout and force=1.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { etDateString, generateText, AI_TIMEOUT_MS } from '../shared.js'
import { handleNHL } from '../nhl.js'
import { handlePWHL } from '../pwhl.js'
import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'
import { makeEnv, makeCtx, makeRequest, makeFakeRateLimiter } from './route-harness.js'

const realFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' }))
})
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

const call = (handler, path, env = makeEnv(), init) =>
  handler(makeRequest(path, init), env, makeCtx(), new URL(`https://example.com${path}`))
const fetchedUrls = () => globalThis.fetch.mock.calls.map(([u]) => String(u))

describe('etDateString', () => {
  it('is the Eastern calendar date, not UTC', () => {
    // 04:30 UTC is still the previous evening in New York (EST, UTC-5).
    expect(etDateString(new Date('2026-01-16T04:30:00Z'))).toBe('2026-01-15')
    expect(etDateString(new Date('2026-01-16T05:30:00Z'))).toBe('2026-01-16')
    // EDT (UTC-4) in summer.
    expect(etDateString(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
    expect(etDateString(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01')
  })

  it('follows the DST switch', () => {
    // 2026-03-08 07:00 UTC = 03:00 EDT, just after the spring-forward.
    expect(etDateString(new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08')
    expect(etDateString(new Date('2026-03-08T04:59:00Z'))).toBe('2026-03-07')
  })

  it('zero-pads month and day', () => {
    expect(etDateString(new Date('2026-02-03T17:00:00Z'))).toBe('2026-02-03')
  })
})

describe('/game-log gameType', () => {
  it('filters game_type when gameType is given, and keys the cache on it', async () => {
    const env = makeEnv()
    await call(handleNHL, '/game-log?team=CAR&season=20262027&gameType=2', env)
    expect(fetchedUrls()[0]).toContain('game_log?season=eq.20262027&team=eq.CAR&game_type=eq.2&order=game_id.asc')
    expect(await env.CACHE.get('nhl:game-log:CAR:20262027:2:all')).not.toBeNull()
  })

  it('omitted, returns every type as before', async () => {
    await call(handleNHL, '/game-log?team=CAR&season=20262027')
    expect(fetchedUrls()[0]).not.toContain('game_type=')
  })

  it('400s on an unknown gameType', async () => {
    const res = await call(handleNHL, '/game-log?team=CAR&season=20262027&gameType=9')
    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('/nhl/shots paging', () => {
  it('pages shot_events on a total order (game_id, then id)', async () => {
    globalThis.fetch = vi.fn(async (u) => {
      const url = String(u)
      if (url.includes('club-schedule-season')) {
        return { ok: true, status: 200, json: async () => ({ games: [{ id: 2026020001, gameState: 'OFF' }] }) }
      }
      return { ok: true, status: 200, json: async () => [] }
    })
    await call(handleNHL, '/nhl/shots?team=CAR&season=20262027')
    const shots = fetchedUrls().find(u => u.includes('/rest/v1/shot_events'))
    expect(shots).toContain('&order=game_id.asc,id.asc')
  })
})

describe('/pp-units/refresh', () => {
  it('points at /special-teams (the /cache/ route does not serve pp_units)', async () => {
    const res = await call(handleNHL, '/pp-units/refresh?secret=test-poll-secret&season=20262027&gameType=2')
    const body = await res.json()
    expect(body.status).toContain('/special-teams?season=20262027&gameType=2')
    expect(body.status).not.toContain('/cache/')
  })
})

describe('generateText', () => {
  it('gives the OpenRouter call a 25s timeout signal', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }))
    await generateText(makeEnv(), { messages: [{ role: 'user', content: 'x' }] })
    expect(AI_TIMEOUT_MS).toBe(25000)
    expect(globalThis.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})

// A limiter that refuses everything: a route that still answers 200 must
// have served the cache without asking it.
const refusingEnv = (kv = {}) => {
  const env = makeEnv({ AI_ROUTE_LIMITER: makeFakeRateLimiter(vi.fn().mockResolvedValue({ success: false })) })
  for (const [k, v] of Object.entries(kv)) env.CACHE._store.set(k, JSON.stringify(v))
  return env
}

describe('AI routes: cached answers are not rate-limited', () => {
  const h2hBody = { teamA: 'CAR', teamB: 'TOR', totalMeetings: 5, allTimeRecord: { teamAWins: 3, teamBWins: 2 }, recentWindow: { size: 5, teamAWins: 3, teamBWins: 2 } }
  const cases = [
    { name: '/prediction/analyze', handler: handleNHL, path: '/prediction/analyze?gameId=2026020001&team=CAR', key: 'prediction:2026020001:CAR' },
    { name: '/summary/narrative', handler: handleNHL, path: '/summary/narrative?gameId=2026020001&period=game&carAbbr=CAR', key: 'narrative:game:2026020001:CAR', method: 'POST', body: {} },
    { name: '/team-seasons/head-to-head/narrative', handler: handleNHL, path: '/team-seasons/head-to-head/narrative', key: 'nhl:h2h-narrative:CAR,TOR', method: 'POST', body: h2hBody },
    { name: '/pwhl/prediction', handler: handlePWHL, path: '/pwhl/prediction?gameId=210', key: 'pwhl:prediction:elo:210' },
    { name: '/pwhl/summary/narrative', handler: handlePWHL, path: '/pwhl/summary/narrative?gameId=210&period=1&carAbbr=BOS', key: 'pwhl:narrative:1:210:BOS', method: 'POST', body: {} },
    { name: '/pwhl/team-seasons/head-to-head/narrative', handler: handlePWHL, path: '/pwhl/team-seasons/head-to-head/narrative', key: null, method: 'POST', body: h2hBody },
    { name: '/ahl/prediction', handler: handleAHL, path: '/ahl/prediction?gameId=1028992', key: 'ahl:prediction:elo:1028992' },
    { name: '/echl/prediction', handler: handleECHL, path: '/echl/prediction?gameId=1028992', key: 'echl:prediction:elo:1028992' },
  ]

  for (const c of cases.filter(c => c.key)) {
    it(`${c.name}: a cache hit answers 200 without the limiter; a miss is limited`, async () => {
      const init = c.method ? { method: c.method, body: c.body } : undefined
      const hit = await call(c.handler, c.path, refusingEnv({ [c.key]: { cached: true } }), init)
      expect(hit.status).toBe(200)
      expect(await hit.json()).toEqual({ cached: true })

      const miss = await call(c.handler, c.path, refusingEnv(), init)
      expect(miss.status).toBe(429)
    })
  }

  it('the AHL/ECHL and PWHL head-to-head narratives also check the cache first', async () => {
    for (const [handler, prefix] of [[handlePWHL, '/pwhl'], [handleAHL, '/ahl'], [handleECHL, '/echl']]) {
      const env = refusingEnv()
      const path = `${prefix}/team-seasons/head-to-head/narrative`
      const miss = await call(handler, path, env, { method: 'POST', body: h2hBody })
      expect(miss.status).toBe(429)
      // Whatever key the route caches under, a warm one answers without the limiter.
      const limiter = env.AI_ROUTE_LIMITER.limit
      limiter.mockClear()
      globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Narrative.' } }] }) }))
      limiter.mockResolvedValueOnce({ success: true })
      const filled = await call(handler, path, env, { method: 'POST', body: h2hBody })
      expect(filled.status).toBe(200)
      limiter.mockClear()
      const hit = await call(handler, path, env, { method: 'POST', body: h2hBody })
      expect(hit.status).toBe(200)
      expect(limiter).not.toHaveBeenCalled()
    }
  })
})

describe('force=1 needs the secret', () => {
  const routes = [
    [handleNHL, '/prediction/analyze?gameId=2026020001&team=CAR&force=1'],
    [handlePWHL, '/pwhl/prediction?gameId=210&force=1'],
    [handleAHL, '/ahl/prediction?gameId=1028992&force=1'],
    [handleECHL, '/echl/prediction?gameId=1028992&force=1'],
  ]
  for (const [handler, path] of routes) {
    it(`${path.split('?')[0]}: 401 without it, regenerates with it`, async () => {
      const denied = await call(handler, path)
      expect(denied.status).toBe(401)
      expect(await call(handler, `${path}&secret=wrong`).then(r => r.status)).toBe(401)
      expect(globalThis.fetch).not.toHaveBeenCalled()

      // With the secret the cache is skipped (and the route goes on to its
      // own reads, here answering whatever the empty fixtures give).
      const env = makeEnv()
      const allowed = await call(handler, `${path}&secret=test-poll-secret`, env)
      expect(allowed.status).not.toBe(401)
      expect(globalThis.fetch).toHaveBeenCalled()
    })
  }

  it('without force, no secret is needed (a cache hit is served)', async () => {
    const env = makeEnv()
    env.CACHE._store.set('pwhl:prediction:elo:210', JSON.stringify({ cached: true }))
    const res = await call(handlePWHL, '/pwhl/prediction?gameId=210', env)
    expect(res.status).toBe(200)
  })
})
