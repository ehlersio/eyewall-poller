// src/__tests__/nhl-routes.test.js
// Route-level tests for a first batch of handleNHL's ~42 routes (Session
// 47, Item 2 — audit #9). None of these had any HTTP-level coverage
// before this session. Covers a representative slice, not all 42:
// - /health and /cache/:key (simplest reads, no upstream fetch)
// - /player-analytics (Session 44's Direct-Supabase-read proxy shape --
//   cache hit, happy path, upstream 502)
// - /player-shots (query-param validation: 400 on missing required param)
// - /push/subscribe and /push/unsubscribe (mutating, higher audit
//   priority than reads -- assert the actual KV write, not just a 200)
//
// The remaining read-proxy routes (~35) follow the exact same shape as
// /player-analytics/-shots (parse params -> cache check -> sbRows() ->
// cache write -> JSON) and are mechanical to extend from this pattern in
// a follow-up session.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, flushWaitUntil } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
}))

import { handleNHL } from '../nhl.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('GET /health', () => {
  it('reports subscriber count and live game id from KV, defaulting when both are cold', async () => {
    const env = makeEnv()
    const res = await handleNHL(makeRequest('/health'), env, makeCtx(), new URL('https://example.com/health'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, liveGameId: null, subscribers: 0 })
  })

  it('reflects real KV state when populated', async () => {
    const env = makeEnv({
      CACHE: {
        async get(key) {
          if (key === 'live:gameId') return JSON.stringify(2025030415)
          if (key === 'push:subs') return JSON.stringify([{ endpoint: 'a' }, { endpoint: 'b' }])
          return null
        },
        async put() {},
      },
    })

    const res = await handleNHL(makeRequest('/health'), env, makeCtx(), new URL('https://example.com/health'))
    const body = await res.json()

    expect(body.liveGameId).toBe(2025030415)
    expect(body.subscribers).toBe(2)
  })
})

describe('GET /cache/:key', () => {
  it('returns 404 for a cold, non-schedule key (no background fetch to trigger)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/cache/nhl:player-analytics:20252026'),
      env, makeCtx(),
      new URL('https://example.com/cache/nhl:player-analytics:20252026')
    )
    expect(res.status).toBe(404)
  })

  it('returns the cached value on a hit', async () => {
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify({ hello: 'world' }) }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/cache/some:key'), env, makeCtx(), new URL('https://example.com/cache/some:key')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: 'world' })
  })
})

describe('GET /player-analytics', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify({ rows: ['cached'], poRows: [] }) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: ['cached'], poRows: [] })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches from Supabase on a cache miss and caches the result', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ player_id: 1, war: 2.1 }],
    })

    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ player_id: 1, war: 2.1 }])
    // Cached for next time
    const cached = await env.CACHE.get('nhl:player-analytics:20252026')
    expect(JSON.parse(cached).rows).toEqual([{ player_id: 1, war: 2.1 }])
  })

  it('returns 502 when the Supabase fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )

    expect(res.status).toBe(502)
  })
})

describe('GET /player-shots', () => {
  it('400s when playerId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/player-shots?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-shots?season=20252026')
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /push/subscribe', () => {
  it('adds a new subscription and defaults league prefix to NHL', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { endpoint: 'ep-1', keys: { p256dh: 'x', auth: 'y' } } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).total).toBe(1)
    const stored = JSON.parse(await env.CACHE.get('push:subs'))
    expect(stored).toEqual([{ endpoint: 'ep-1', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'NHL:CAR', prefs: null }])
  })

  it('updates in place (dedupes by endpoint) on re-subscribe rather than appending a duplicate', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([{ endpoint: 'ep-1', teamAbbr: 'NHL:CAR', prefs: null }])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { endpoint: 'ep-1', teamAbbr: 'BOS' } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect((await res.json()).total).toBe(1)
  })
})

describe('POST /push/unsubscribe', () => {
  it('removes the matching subscription by endpoint', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([{ endpoint: 'ep-1' }, { endpoint: 'ep-2' }])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/unsubscribe', { method: 'POST', body: { endpoint: 'ep-1' } }),
      env, makeCtx(), new URL('https://example.com/push/unsubscribe')
    )

    expect((await res.json()).total).toBe(1)
  })
})

describe('GET /news (cold cache background-fetch pattern)', () => {
  it('returns [] immediately on a cache miss and schedules a background fetch via ctx.waitUntil', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/news'), env, ctx, new URL('https://example.com/news')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx) // let the background fetch settle before the test ends
  })
})
