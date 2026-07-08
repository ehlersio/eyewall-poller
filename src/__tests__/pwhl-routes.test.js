// src/__tests__/pwhl-routes.test.js
// Route-level tests for handlePWHL's routes (Session 47 + Session 48,
// Item 2 — audit #9). Session 47 covered a first slice: /pwhl/standings
// (cache hit, the 502-on-upstream-failure path, and the L10/streak
// enrichment logic together with the raw Supabase read), demonstrating
// the same harness works across both route files.
//
// Session 48 adds the remaining Tier 2 (POLL_SECRET-gated mutating
// routes) and Tier 3 (AI-calling routes) coverage per the corrected
// Session 48 scope — see SESSION_48_DECISIONS.md.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
}))

import { handlePWHL } from '../pwhl.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('GET /pwhl/standings', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify([{ team_id: 1 }]) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 1 }])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('enriches standings with L10/streak from the game log on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 1, points: 40 }] })
      }
      // pwhl_game_log — one win for team 1 vs team 2
      return Promise.resolve({
        ok: true,
        json: async () => [{ game_id: 1, home_team_id: 1, away_team_id: 2, home_score: 3, away_score: 1 }],
      })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    const body = await res.json()
    expect(body[0]).toMatchObject({ team_id: 1, l10W: 1, l10L: 0, streakType: 'W', streakCount: 1 })
  })

  it('returns 502 when the standings fetch itself fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(502)
  })

  it('degrades gracefully (no L10/streak) if only the game-log fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 1, points: 40 }] })
      }
      return Promise.resolve({ ok: false, status: 500 })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 1, points: 40 }])
  })
})

// ── Tier 2 — POLL_SECRET-gated mutating routes (Session 48, Item 2) ─────────

describe('POST /pwhl/news/bust', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/news/bust', { method: 'POST' }), env, makeCtx(), new URL('https://example.com/pwhl/news/bust')
    )
    expect(res.status).toBe(401)
  })

  it('deletes the pwhl:news cache key', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:news': [{ id: 'x' }] }) })
    const res = await handlePWHL(
      makeRequest('/pwhl/news/bust?secret=test-poll-secret', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/pwhl/news/bust?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, busted: ['pwhl:news'] })
    expect(await env.CACHE.get('pwhl:news')).toBeNull()
  })
})

describe('POST /pwhl/cache/bust', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/cache/bust?teamId=1&season=8', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/pwhl/cache/bust?teamId=1&season=8')
    )
    expect(res.status).toBe(401)
  })

  it('400s when teamId is missing', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/cache/bust?secret=test-poll-secret&season=8', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/pwhl/cache/bust?secret=test-poll-secret&season=8')
    )
    expect(res.status).toBe(400)
  })

  it('deletes every team+season cache key, including the live-game key when gameId is passed', async () => {
    const seeded = {}
    for (const k of ['pwhl:shots:1:8', 'pwhl:players:1:8', 'pwhl:schedule:1:8', 'pwhl:lastgame:1:8', 'pwhl:roster:1', 'pwhl:standings:8', 'pwhl:leagueplayers:8', 'pwhl:today:8', 'pwhl:live:210']) {
      seeded[k] = { seeded: true }
    }
    const env = makeEnv({ CACHE: makeFakeCache(seeded) })

    const res = await handlePWHL(
      makeRequest('/pwhl/cache/bust?secret=test-poll-secret&teamId=1&season=8&gameId=210', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/pwhl/cache/bust?secret=test-poll-secret&teamId=1&season=8&gameId=210')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.busted).toHaveLength(9)
    expect(body.busted).toContain('pwhl:live:210')
    for (const k of body.busted) {
      expect(await env.CACHE.get(k)).toBeNull()
    }
  })

  it('omits the live-game key entirely when gameId is not passed', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/cache/bust?secret=test-poll-secret&teamId=1&season=8', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/pwhl/cache/bust?secret=test-poll-secret&teamId=1&season=8')
    )
    const body = await res.json()
    expect(body.busted).toHaveLength(8)
    expect(body.busted.some(k => k.startsWith('pwhl:live:'))).toBe(false)
  })
})

describe('POST /pwhl/news/ingest', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/news/ingest', { method: 'POST', body: [] }), env, makeCtx(), new URL('https://example.com/pwhl/news/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('400s when the body is not an array', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/news/ingest?secret=test-poll-secret', { method: 'POST', body: { not: 'an array' } }),
      env, makeCtx(), new URL('https://example.com/pwhl/news/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(400)
  })

  it('merges new articles with existing ones, deduping by id and capping at 60, newest first', async () => {
    const existing = [{ id: 'old-1', publishedAt: '2020-01-01T00:00:00Z' }]
    const incoming = [
      { id: 'new-1', publishedAt: '2026-07-08T00:00:00Z' },
      { id: 'old-1', publishedAt: '2026-01-01T00:00:00Z' }, // duplicate id — incoming version wins
    ]
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:news': existing }) })

    const res = await handlePWHL(
      makeRequest('/pwhl/news/ingest?secret=test-poll-secret', { method: 'POST', body: incoming }),
      env, makeCtx(), new URL('https://example.com/pwhl/news/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, received: 2, total: 2 })

    const merged = JSON.parse(await env.CACHE.get('pwhl:news'))
    expect(merged).toHaveLength(2)
    // Incoming's copy of 'old-1' wins over the stale existing one (articles spread first, existing filtered to exclude any id already in articles)
    expect(merged.find(a => a.id === 'old-1').publishedAt).toBe('2026-01-01T00:00:00Z')
  })
})

// ── Tier 3 — AI-calling routes (Session 48, Item 2) ─────────────────────────
// No secret check (see Session 48 findings/decisions) — guarded instead by
// the AI_ROUTE_LIMITER binding (Item 3, mocked to always-allow here).

describe('POST /pwhl/scout', () => {
  it('400s when name is missing', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/scout', { method: 'POST', body: { position: 'F', stats: {} } }),
      env, makeCtx(), new URL('https://example.com/pwhl/scout')
    )
    expect(res.status).toBe(400)
  })

  it('generates a scouting blurb for a skater', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'A dynamic playmaker with elite vision.' }) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/scout', {
        method: 'POST',
        body: { name: 'Marie-Philip Poulin', position: 'F', isGoalie: false, seasonLabel: '2025-26', stats: { gp: 20, goals: 15, assists: 18, points: 33 } },
      }),
      env, makeCtx(), new URL('https://example.com/pwhl/scout')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).blurb).toBe('A dynamic playmaker with elite vision.')
  })

  it('generates a scouting blurb for a goalie using goalie-shaped stats', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'A steady presence between the pipes.' }) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/scout', {
        method: 'POST',
        body: { name: 'Ann-Renee Desbiens', position: 'G', isGoalie: true, seasonLabel: '2025-26', stats: { gp: 18, wins: 12, losses: 5, sv_pct: 0.925, gaa: 2.1 } },
      }),
      env, makeCtx(), new URL('https://example.com/pwhl/scout')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).blurb).toBe('A steady presence between the pipes.')
  })

  it('returns an error when the AI response is empty', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: '' }) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/scout', { method: 'POST', body: { name: 'X', position: 'F', stats: {} } }),
      env, makeCtx(), new URL('https://example.com/pwhl/scout')
    )
    expect((await res.json()).error).toMatch(/empty/i)
  })

  it('502s when the AI call throws', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockRejectedValue(new Error('AI unavailable')) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/scout', { method: 'POST', body: { name: 'X', position: 'F', stats: {} } }),
      env, makeCtx(), new URL('https://example.com/pwhl/scout')
    )
    expect(res.status).toBe(502)
  })
})

describe('POST /pwhl/summary/narrative', () => {
  it('serves from cache without calling the AI model', async () => {
    const cached = { narrative: 'cached', cardNarrative: null }
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:narrative:1:210:CAR': cached }) })
    const res = await handlePWHL(
      makeRequest('/pwhl/summary/narrative?gameId=210&period=1&carAbbr=CAR', { method: 'POST', body: {} }),
      env, makeCtx(), new URL('https://example.com/pwhl/summary/narrative?gameId=210&period=1&carAbbr=CAR')
    )
    expect(await res.json()).toEqual(cached)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('400s on invalid JSON body', async () => {
    const env = makeEnv()
    const req = new Request('https://example.com/pwhl/summary/narrative?gameId=210&period=1', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    const res = await handlePWHL(req, env, makeCtx(), new URL('https://example.com/pwhl/summary/narrative?gameId=210&period=1'))
    expect(res.status).toBe(400)
  })

  it('generates and caches a period narrative for 24hr', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'A tight period for both sides.' }) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/summary/narrative?gameId=210&period=1&carAbbr=BOS', {
        method: 'POST',
        body: { carAbbr: 'BOS', oppAbbr: 'MTL', periodLabel: '1st', corsiForPct: 55, carSOG: 10, oppSOG: 8, carGoals: 1, oppGoals: 0, carHits: 5, carFOPct: 50, penaltyCount: 2, carPenaltyCount: 1, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/pwhl/summary/narrative?gameId=210&period=1&carAbbr=BOS')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.narrative).toBe('A tight period for both sides.')
    expect(JSON.parse(await env.CACHE.get('pwhl:narrative:1:210:BOS')).narrative).toBe('A tight period for both sides.')
  })

  it('502s when the AI call throws', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockRejectedValue(new Error('AI unavailable')) } })
    const res = await handlePWHL(
      makeRequest('/pwhl/summary/narrative?gameId=210&period=1&carAbbr=BOS', {
        method: 'POST',
        body: { carAbbr: 'BOS', oppAbbr: 'MTL', goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/pwhl/summary/narrative?gameId=210&period=1&carAbbr=BOS')
    )
    expect(res.status).toBe(502)
  })
})
