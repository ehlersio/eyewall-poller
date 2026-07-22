// src/__tests__/nhl-routes.test.js
// Route-level tests for handleNHL's routes (Session 47 + Session 48, Item
// 2 — audit #9). None of these had any HTTP-level coverage before Session
// 47. Session 47 covered a representative slice of the read-proxy tier:
// - /health and /cache/:key (simplest reads, no upstream fetch)
// - /player-analytics (Session 44's Direct-Supabase-read proxy shape --
//   cache hit, happy path, upstream 502)
// - /player-shots (query-param validation: 400 on missing required param)
// - /push/subscribe and /push/unsubscribe (mutating, higher audit
//   priority than reads -- assert the actual KV write, not just a 200)
//
// Session 48 adds the remaining two tiers per the corrected Session 48
// scope (see SESSION_48_DECISIONS.md): Tier 2 (POLL_SECRET-gated
// mutating/ingest routes -- assert actual KV mutations/merge logic, not
// just status codes) and Tier 3 (AI-calling routes). The other ~35
// read-proxy routes still follow the exact same shape as
// /player-analytics/-shots and remain mechanical to extend if ever needed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, flushWaitUntil, makeFakeCache } from './route-harness.js'

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

// ── Season-aware /schedule (Session 77 — shot map history selector) ──
// Key shape moved from `schedule:{abbr}` to `schedule:{abbr}:{season}` so
// multiple seasons can be cached side by side. Current season keeps the
// short (10 min) TTL; any other explicitly-requested season is treated as
// historical/immutable and gets a long TTL instead.
describe('GET /schedule', () => {
  it('cold cache, no ?season=: background-fetches the current season and caches it under the season-namespaced key with the short TTL', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 1 }] }) })
    const ctx = makeCtx()

    const res = await handleNHL(makeRequest('/schedule'), env, ctx, new URL('https://example.com/schedule'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    await flushWaitUntil(ctx)

    expect(putSpy).toHaveBeenCalledWith('schedule:CAR:20252026', JSON.stringify([{ id: 1 }]), { expirationTtl: 600 })
  })

  it('cold cache, explicit historical ?season=: fetches and returns that season SYNCHRONOUSLY (no background/retry-later gap), caching it with the long TTL', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 99 }] }) })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/schedule?season=20232024'), env, ctx,
      new URL('https://example.com/schedule?season=20232024')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 99 }]) // real data immediately, not []
    expect(ctx._promises.length).toBe(0) // no ctx.waitUntil — this path doesn't defer

    expect(putSpy).toHaveBeenCalledWith('schedule:CAR:20232024', JSON.stringify([{ id: 99 }]), { expirationTtl: 60 * 24 * 3600 })
  })

  it('warm cache for a specific historical season: serves directly from KV, no background fetch triggered', async () => {
    const cachedGames = [{ id: 5 }]
    const env = makeEnv({
      CACHE: { async get(key) { return key === 'schedule:CAR:20232024' ? JSON.stringify(cachedGames) : null }, async put() {} },
    })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/schedule?season=20232024'), env, ctx,
      new URL('https://example.com/schedule?season=20232024')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedGames)
    expect(ctx._promises.length).toBe(0)
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

  // Session 66: the live season can be flipped ahead of any real games
  // (schedule released before puck drop), leaving `war=not.is.null` match
  // nothing for it -- same whole-season-empty shape as
  // /players-search-index's team-lookup fallback (#22).
  describe('the live season has zero rows (season flipped ahead of real data)', () => {
    function mockFetchWithPriorSeason(priorRows) {
      globalThis.fetch = vi.fn((url) => {
        const u = String(url)
        if (u.includes('season=eq.20262027')) {
          return Promise.resolve({ ok: true, json: async () => [] }) // live season: nothing yet
        }
        if (u.includes('season=eq.20252026') && u.includes('game_type=eq.2')) {
          return Promise.resolve({ ok: true, json: async () => priorRows })
        }
        if (u.includes('season=eq.20252026') && u.includes('game_type=eq.3')) {
          return Promise.resolve({ ok: true, json: async () => [] })
        }
        throw new Error(`unexpected fetch: ${u}`)
      })
    }

    it('falls back one season back and flags the result as stale with the specific season, not just non-empty', async () => {
      mockFetchWithPriorSeason([{ player_id: 8478402, war: 4.2, pct_goals: 91 }])

      const res = await handleNHL(
        makeRequest('/player-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/player-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      // Asserts the specific fallback season and rows, not just "truthy" --
      // a wrong-season fallback would also satisfy a bare non-null check.
      expect(body).toEqual({
        rows: [{ player_id: 8478402, war: 4.2, pct_goals: 91 }],
        poRows: [],
        statsStale: true,
        statsSeason: '20252026',
      })
    })

    it('degrades to an explicit empty, non-stale result when the prior season has no rows either', async () => {
      mockFetchWithPriorSeason([]) // no rows in the prior season either

      const res = await handleNHL(
        makeRequest('/player-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/player-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ rows: [], poRows: [], statsStale: false, statsSeason: null })
    })
  })
})

describe('GET /player-results-vs-process', () => {
  it('400s when playerId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/player-results-vs-process?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?season=20252026')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRow = [{ narrative_text: 'cached blurb', generated_at: '2026-01-01' }]
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify(cachedRow) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=1&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=1&season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRow)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches the narrative_type=results_vs_process row from Supabase on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ narrative_text: 'Kopitar is outperforming his process...', generated_at: '2026-01-01' }],
    })

    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=8471685&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=8471685&season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0].narrative_text).toContain('outperforming')

    const fetchedUrl = globalThis.fetch.mock.calls[0][0]
    expect(String(fetchedUrl)).toContain('player_narratives')
    expect(String(fetchedUrl)).toContain('narrative_type=eq.results_vs_process')
    expect(String(fetchedUrl)).toContain('player_id=eq.8471685')

    const cached = await env.CACHE.get('nhl:player-results-vs-process:8471685:20252026')
    expect(JSON.parse(cached)[0].narrative_text).toContain('outperforming')
  })

  it('returns an empty array (not a 502) when the Supabase fetch fails', async () => {
    // Mirrors /player-scouting's swallow-and-return-[] behavior -- a missing
    // narrative shouldn't surface as an error to the player popup.
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=1&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=1&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /team-seasons', () => {
  it('selects magic/tragic number columns but not clinch_indicator (Session 59 — live standings is the clinch source of truth)', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', xgf_pct: 0.52, roster_war_score: 12.3, games_played: 60, magic_number: 4, tragic_number: 40, clinched: false, eliminated: false },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).toMatchObject({ team: 'CAR', magic_number: 4, tragic_number: 40, clinched: false, eliminated: false })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('magic_number')
    expect(fetchedUrl).toContain('tragic_number')
    expect(fetchedUrl).toContain('clinched')
    expect(fetchedUrl).toContain('eliminated')
    expect(fetchedUrl).not.toContain('clinch_indicator')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ team: 'CAR', magic_number: 2 }]
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /team-seasons/compare', () => {
  it('400s when team or seasons is missing', async () => {
    const env = makeEnv()
    const noTeam = await handleNHL(
      makeRequest('/team-seasons/compare?seasons=20262027,20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?seasons=20262027,20252026')
    )
    expect(noTeam.status).toBe(400)

    const noSeasons = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR')
    )
    expect(noSeasons.status).toBe(400)
  })

  it('queries box-score columns only (not xgf_pct/roster_war_score) for the given team + season list', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { season: 20262027, games_played: 5,  wins: 4, losses: 1, ot_losses: 0, points: 8,  goals_for: 20, goals_against: 10, pp_pct: 25.0, pk_pct: 80.0 },
        { season: 20252026, games_played: 82, wins: 45, losses: 30, ot_losses: 7, points: 97, goals_for: 260, goals_against: 230, pp_pct: 22.5, pk_pct: 78.3 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR&seasons=20262027,20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR&seasons=20262027,20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ season: 20262027, wins: 4, points: 8 })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=eq.CAR')
    expect(fetchedUrl).toContain('season=in.(20262027,20252026)')
    expect(fetchedUrl).toContain('game_type=eq.2')
    expect(fetchedUrl).toContain('goals_for')
    expect(fetchedUrl).toContain('pp_pct')
    expect(fetchedUrl).not.toContain('xgf_pct')
    expect(fetchedUrl).not.toContain('roster_war_score')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ season: 20252026, wins: 45 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR&seasons=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR&seasons=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
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

  // Regression: car_game on the shot_events table only means "Carolina
  // played in this game" (see eyewall-pipeline's shot_events.py), not
  // "the requested team played in this game" -- filtering on it here
  // silently restricted every non-CAR player's shots to games against
  // Carolina. Assert it's gone from the outbound query, and that a non-CAR
  // team param is passed through untouched.
  it('does not filter on car_game, and passes a non-CAR team through', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    await handleNHL(
      makeRequest('/player-shots?playerId=8478402&season=20252026&team=TOR'), env, makeCtx(),
      new URL('https://example.com/player-shots?playerId=8478402&season=20252026&team=TOR')
    )

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).not.toContain('car_game')
    expect(fetchedUrl).toContain('team=eq.TOR')
    expect(fetchedUrl).toContain('player_id=eq.8478402')
  })
})

describe('GET /nhl/shots', () => {
  // Regression: an earlier version of this route filtered shot_events on
  // car_game=eq.true, which only ever means "Carolina played in this game"
  // -- for any other requested team that would have silently returned
  // CAR's shots instead of the requested team's. Assert the route resolves
  // the requested team's own game_ids from the NHL schedule API first and
  // scopes shot_events by that game_id list instead.
  it('resolves game_ids from the requested (non-CAR) team schedule, not car_game', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        expect(u).toContain('club-schedule-season/TOR/20252026')
        return Promise.resolve({
          ok: true,
          json: async () => ({
            games: [
              { id: 2025020001, gameState: 'OFF' },
              { id: 2025020002, gameState: 'FUT' }, // not completed -- excluded
              { id: 2025020003, gameState: 'FINAL' },
            ],
          }),
        })
      }
      // Supabase shot_events call
      expect(u).not.toContain('car_game')
      expect(u).toContain('game_id=in.(2025020001,2025020003)')
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=TOR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=TOR&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('returns an empty array without querying Supabase when the team has no completed games', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ id: 1, gameState: 'FUT' }] }),
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=SEA&season=20252026'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=SEA&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // schedule only, no Supabase call
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

// ── Tier 2 — POLL_SECRET-gated mutating/ingest routes (Session 48, Item 2) ──
// Each of these asserts the actual KV mutation/merge logic per the Session
// 48 decision, not just the response status code.

describe('POST /reddit/ingest', () => {
  const REDDIT_BUNDLE = {
    CAR: {
      data: {
        children: [{
          data: {
            id: 'abc123', title: 'Canes sign new deal', permalink: '/r/canes/comments/abc123/x/',
            selftext: '', score: 42, num_comments: 7, created_utc: 1751932800,
            stickied: false, removed: false, url: 'https://www.reddit.com/r/canes/comments/abc123/x/', is_self: true,
          },
        }],
      },
    },
  }

  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/reddit/ingest', { method: 'POST', body: REDDIT_BUNDLE }),
      env, makeCtx(), new URL('https://example.com/reddit/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('merges reddit posts into news:ABBR, preserving existing non-reddit items', async () => {
    const existing = [{ id: 'canescountry-xyz', source: 'canescountry', title: 'Old article', publishedAt: '2020-01-01T00:00:00Z' }]
    const env = makeEnv({ CACHE: makeFakeCache({ 'news:CAR': existing }) })

    const res = await handleNHL(
      makeRequest('/reddit/ingest?secret=test-poll-secret', { method: 'POST', body: REDDIT_BUNDLE }),
      env, makeCtx(), new URL('https://example.com/reddit/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.processed).toBe(1)
    expect(body.results.CAR).toBe(1)

    const merged = JSON.parse(await env.CACHE.get('news:CAR'))
    expect(merged).toHaveLength(2)
    expect(merged.some(i => i.id === 'reddit-abc123')).toBe(true)
    expect(merged.some(i => i.id === 'canescountry-xyz')).toBe(true)
  })

  it('accepts the ingest secret via x-ingest-secret header too', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/reddit/ingest', { method: 'POST', body: REDDIT_BUNDLE, headers: { 'x-ingest-secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/reddit/ingest')
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /atom/ingest', () => {
  const ATOM_XML = '<?xml version="1.0"?><feed><entry><title>Canes win big</title><link href="https://example.com/article1"/><summary>Great game recap</summary><published>2026-07-08T00:00:00Z</published></entry></feed>'

  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/atom/ingest', { method: 'POST', body: { canescountry: ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('merges parsed atom articles into news:ABBR, preserving items from other sources', async () => {
    const existing = [{ id: 'reddit-old1', source: 'reddit-car', title: 'Old reddit post', publishedAt: '2020-01-01T00:00:00Z' }]
    const env = makeEnv({ CACHE: makeFakeCache({ 'news:CAR': existing }) })

    const res = await handleNHL(
      makeRequest('/atom/ingest?secret=test-poll-secret', { method: 'POST', body: { canescountry: ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.canescountry).toBe(1)

    const merged = JSON.parse(await env.CACHE.get('news:CAR'))
    expect(merged).toHaveLength(2)
    expect(merged.some(i => i.source === 'reddit-car')).toBe(true)
  })

  it('ignores an unrecognized source id', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/atom/ingest?secret=test-poll-secret', { method: 'POST', body: { 'not-a-real-source': ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual({})
  })
})

describe('POST /moneypuck/ingest', () => {
  const CSV = 'playerId,name,team,situation,icetime\n' +
    '1,Player One,CAR,all,72000\n' +
    '2,Player Two,CAR,5on5,60000\n' +
    '3,Player Three,BOS,all,50000\n'

  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/ingest', { method: 'POST', body: CSV }),
      env, makeCtx(), new URL('https://example.com/moneypuck/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('400s on a too-short body', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/ingest?secret=test-poll-secret', { method: 'POST', body: 'too short' }),
      env, makeCtx(), new URL('https://example.com/moneypuck/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(400)
  })

  it('stores raw rows, clears every team\'s cache, and kicks off background computation for all 32 teams', async () => {
    const env = makeEnv()
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/moneypuck/ingest?secret=test-poll-secret', { method: 'POST', body: CSV }),
      env, ctx, new URL('https://example.com/moneypuck/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toBe(3)
    expect(body.teams).toBe(32)

    const raw = JSON.parse(await env.CACHE.get('moneypuck:raw'))
    expect(raw).toHaveLength(3)
    expect(ctx._promises.length).toBe(32)
    await flushWaitUntil(ctx)
  })
})

describe('GET /moneypuck/refresh/all', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/refresh/all'), env, makeCtx(), new URL('https://example.com/moneypuck/refresh/all')
    )
    expect(res.status).toBe(401)
  })

  it('clears the shared + per-team caches and refreshes all 32 teams in the background', async () => {
    const env = makeEnv({
      CACHE: {
        _deleted: [],
        async get() { return null },
        async put() {},
        async delete(key) { this._deleted.push(key) },
      },
    })
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'playerId,name\n1,X\n' })

    const res = await handleNHL(
      makeRequest('/moneypuck/refresh/all?secret=test-poll-secret'), env, ctx,
      new URL('https://example.com/moneypuck/refresh/all?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    expect(env.CACHE._deleted).toContain('moneypuck:raw')
    expect(env.CACHE._deleted.filter(k => k.startsWith('moneypuck:skaters:'))).toHaveLength(32)
    expect(ctx._promises.length).toBe(32)
    await flushWaitUntil(ctx)
  })
})

describe('GET /moneypuck/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/refresh'), env, makeCtx(), new URL('https://example.com/moneypuck/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('clears the team + raw cache and refreshes in the background', async () => {
    const env = makeEnv({
      CACHE: {
        _deleted: [],
        async get() { return null },
        async put() {},
        async delete(key) { this._deleted.push(key) },
      },
    })
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'playerId,name\n1,X\n' })

    const res = await handleNHL(
      makeRequest('/moneypuck/refresh?secret=test-poll-secret&team=CAR'), env, ctx,
      new URL('https://example.com/moneypuck/refresh?secret=test-poll-secret&team=CAR')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).team).toBe('CAR')
    expect(env.CACHE._deleted).toEqual(expect.arrayContaining(['moneypuck:skaters:CAR', 'moneypuck:raw']))
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx)
  })
})

describe('GET /pp-units/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/pp-units/refresh'), env, makeCtx(), new URL('https://example.com/pp-units/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('kicks off refreshPPUnits in the background', async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/pp-units/refresh?secret=test-poll-secret'), env, ctx,
      new URL('https://example.com/pp-units/refresh?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx)
  })
})

describe('GET /shots/backfill', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/shots/backfill'), env, makeCtx(), new URL('https://example.com/shots/backfill')
    )
    expect(res.status).toBe(401)
  })

  it('counts an already-processed game as done and only processes the remaining unprocessed games', async () => {
    const schedule = [
      { id: 111, gameState: 'FINAL', homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'BOS' } },
      { id: 222, gameState: 'FINAL', homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'TOR' } },
    ]
    const env = makeEnv({
      CACHE: {
        async get(key) {
          if (key === 'schedule:CAR:20252026') return JSON.stringify(schedule)
          if (key === 'shots:done:111') return JSON.stringify(true) // already processed
          return null
        },
        async put() {},
      },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) // pbp fetch fails — aggregatePlayerShots no-ops

    const res = await handleNHL(
      makeRequest('/shots/backfill?secret=test-poll-secret&team=CAR'), env, makeCtx(),
      new URL('https://example.com/shots/backfill?secret=test-poll-secret&team=CAR')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(2)
    expect(body.processed).toBe(1) // only game 222 was in the unprocessed batch
    expect(body.done).toBe(2) // 1 already done + 1 processed just now
    expect(body.remaining).toBe(0)
  })

  it('returns all-zero counts when there are no completed games', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/shots/backfill?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/shots/backfill?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, processed: 0, remaining: 0, total: 0, done: 0 })
  })
})

describe('GET /summary/generate', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/generate'), env, makeCtx(), new URL('https://example.com/summary/generate')
    )
    expect(res.status).toBe(401)
  })

  it('returns an error when there are no completed games in the schedule', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/generate?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/summary/generate?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).error).toMatch(/no completed games/i)
  })
})

describe('GET /news/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/news/refresh'), env, makeCtx(), new URL('https://example.com/news/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('fetches fresh news for the requested team and reports the count', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) // every source fails — count 0, no crash
    const res = await handleNHL(
      makeRequest('/news/refresh?secret=test-poll-secret&team=CAR'), env, makeCtx(),
      new URL('https://example.com/news/refresh?secret=test-poll-secret&team=CAR')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, count: 0, team: 'CAR' })
  })
})

describe('GET /poll (manual trigger)', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/poll'), env, makeCtx(), new URL('https://example.com/poll')
    )
    expect(res.status).toBe(401)
  })

  it('runs the poll loop and reports a timestamp', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ games: [], standings: [] }),
    })

    const res = await handleNHL(
      makeRequest('/poll?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/poll?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.polled).toBeTruthy()
  })
})

describe('GET /social/test', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/social/test'), env, makeCtx(), new URL('https://example.com/social/test')
    )
    expect(res.status).toBe(401)
  })

  it('returns a preview of the post text without actually posting (no ?post=1)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/social/test?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/social/test?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.preview).toBe('string')
    expect(body.length).toBe(body.preview.length)
  })
})

describe('POST /push/test', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/test', { method: 'POST' }), env, makeCtx(), new URL('https://example.com/push/test')
    )
    expect(res.status).toBe(401)
  })

  it('no-ops cleanly when there are no subscribers', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/test?secret=test-poll-secret', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/push/test?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

describe('POST /draft/analyze', () => {
  it('401s without a matching X-Poll-Secret header (not the ?secret= query param convention every other route uses)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/draft/analyze?secret=test-poll-secret', { method: 'POST', body: { prompt: 'x' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze?secret=test-poll-secret')
    )
    expect(res.status).toBe(401) // query param doesn't count for this route
  })

  it('400s when prompt is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: {}, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(400)
  })

  it('returns the AI analysis on a valid request', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Great value pick at this slot.' }) } })
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: { prompt: 'Analyze this pick' }, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).analysis).toBe('Great value pick at this slot.')
  })

  it('502s when the AI response is empty', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: '' }) } })
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: { prompt: 'Analyze this pick' }, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(502)
  })
})

// ── Tier 3 — AI-calling routes (Session 48, Item 2) ──────────────────────
// No secret check on these (see Session 48 findings/decisions — reused
// POLL_SECRET was rejected since these are called from the public
// frontend). Guarded instead by the AI_ROUTE_LIMITER binding (Item 3,
// mocked to always-allow by makeEnv's default here).

describe('GET /prediction/analyze', () => {
  it('returns an error when gameId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/prediction/analyze'), env, makeCtx(), new URL('https://example.com/prediction/analyze')
    )
    expect((await res.json()).error).toMatch(/gameId required/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { gameId: '123', narrative: 'cached narrative' }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'prediction:123' ? JSON.stringify(cached) : null }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )
    expect(await res.json()).toEqual(cached)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('returns an error when the game is not found in the schedule', async () => {
    const env = makeEnv({ CACHE: { async get(key) { return key === 'schedule:CAR:20252026' ? JSON.stringify([]) : null }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=999'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=999')
    )
    expect((await res.json()).error).toMatch(/not found in schedule/i)
  })

  it('generates and caches a prediction for a game with standings on both sides, falling back to the SOG-share proxy when team_seasons has no Corsi data', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 10, wins: 7, losses: 3, otLosses: 0, points: 14, goalFor: 35, goalAgainst: 25, powerPlayPct: 24, penaltyKillPct: 80, shotsForPerGame: 32, shotsAgainstPerGame: 28, streakCode: 'W', streakCount: 3 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 28, goalAgainst: 30, powerPlayPct: 18, penaltyKillPct: 76, shotsForPerGame: 29, shotsAgainstPerGame: 31, streakCode: 'L', streakCount: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: vi.fn().mockResolvedValue({ response: 'CAR should win this one comfortably.' }) },
    })
    // team_seasons has no rows for either team yet (e.g. before the
    // Session 52 Corsi rollup has run for this season) — route must fall
    // back to the SOG-share proxy rather than erroring.
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gameId).toBe('123')
    expect(body.oppAbbr).toBe('BOS')
    expect(body.narrative).toBe('CAR should win this one comfortably.')
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    // SOG-share proxy: carCF = carSF/(carSF+oppSA)*100 = 32/(32+31)*100 = 50.8
    expect(body.carCF).toBe('50.8')
    expect(body.corsiForPct).toEqual({ car: 50.8, opp: expect.any(Number) })
    expect(body.corsiCaveat).toMatch(/shots-on-goal share only/i)

    const cached = JSON.parse(await env.CACHE.get('prediction:123'))
    expect(cached.narrative).toBe('CAR should win this one comfortably.')
  })

  it('uses real 5v5 Corsi from team_seasons when both teams have it, instead of the SOG-share proxy', async () => {
    const schedule = [{ id: 124, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 10, wins: 7, losses: 3, otLosses: 0, points: 14, goalFor: 35, goalAgainst: 25, powerPlayPct: 24, penaltyKillPct: 80, shotsForPerGame: 32, shotsAgainstPerGame: 28, streakCode: 'W', streakCount: 3 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 28, goalAgainst: 30, powerPlayPct: 18, penaltyKillPct: 76, shotsForPerGame: 29, shotsAgainstPerGame: 31, streakCode: 'L', streakCount: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: vi.fn().mockResolvedValue({ response: 'CAR has the possession edge.' }) },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', corsi_for_pct: 0.55, corsi_for_pct_5v5: 0.592 },
        { team: 'BOS', corsi_for_pct: 0.47, corsi_for_pct_5v5: 0.431 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=124'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=124')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // 0.592 * 100 = 59.2 (5v5 preferred over all-situations or SOG proxy)
    expect(body.carCF).toBe('59.2')
    expect(body.corsiForPct).toEqual({ car: 59.2, opp: 43.1 })
    expect(body.corsiCaveat).toMatch(/5-on-5 shot-attempt share/i)
  })
})

describe('POST /summary/narrative', () => {
  it('returns an error when gameId or period is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1', { method: 'POST', body: {} }), env, makeCtx(),
      new URL('https://example.com/summary/narrative?gameId=1')
    )
    expect((await res.json()).error).toMatch(/gameId and period required/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { narrative: 'cached', cardNarrative: null }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'narrative:1:1:CAR' ? JSON.stringify(cached) : null }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=1&carAbbr=CAR', { method: 'POST', body: {} }), env, makeCtx(),
      new URL('https://example.com/summary/narrative?gameId=1&period=1&carAbbr=CAR')
    )
    expect(await res.json()).toEqual(cached)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('returns an error on invalid JSON body', async () => {
    const env = makeEnv()
    const req = new Request('https://example.com/summary/narrative?gameId=1&period=1', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    const res = await handleNHL(req, env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=1'))
    expect((await res.json()).error).toMatch(/invalid body/i)
  })

  it('makes one AI call for a period summary and caches for 30 days', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Period summary text.' }) } })
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=1&carAbbr=CAR', {
        method: 'POST',
        body: { carGoals: 1, oppGoals: 0, corsiForPct: 55, carSOG: 10, oppSOG: 8, carHits: 5, carFOPct: 50, penaltyCount: 2, carPenaltyCount: 1, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=1&carAbbr=CAR')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.narrative).toBe('Period summary text.')
    expect(body.cardNarrative).toBeNull()
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await env.CACHE.get('narrative:1:1:CAR')).narrative).toBe('Period summary text.')
  })

  it('makes two AI calls (narrative + card caption) for a full game summary', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Game summary text.' }) } })
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=game&carAbbr=CAR', {
        method: 'POST',
        body: { carGoals: 3, oppGoals: 1, corsiForPct: 55, carSOG: 30, oppSOG: 22, carHDCF: 10, oppHDCF: 6, carHits: 20, carFOPct: 52, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=game&carAbbr=CAR')
    )

    expect(res.status).toBe(200)
    expect(env.AI.run).toHaveBeenCalledTimes(2)
  })
})
