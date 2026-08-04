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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, flushWaitUntil, makeFakeCache } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
}))

// sendPush does real VAPID JWT signing + RFC8291 payload encryption via
// crypto.subtle -- mocked here so poll()'s dual-broadcast tests can assert
// on *who* got notified without needing real EC key material. Everything
// else in shared.js (kvGet/kvPut against the test env's CACHE mock, etc.)
// stays real. vi.mock factories are hoisted above regular declarations, so
// the mock fn itself must be created via vi.hoisted() to be visible here.
const { sendPushMock } = vi.hoisted(() => ({ sendPushMock: vi.fn().mockResolvedValue('ok') }))
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock }
})

import { handleNHL, poll } from '../nhl.js'
import { resolveNHLSeason } from '../seasons.js'

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

  it('selects hits/penalties season totals (Session 82 — Shot Map "All N" cards)', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', xgf_pct: 0.52, roster_war_score: 12.3, games_played: 60, magic_number: 4, tragic_number: 40, clinched: false, eliminated: false, hits: 1450, penalties: 210 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).toMatchObject({ team: 'CAR', hits: 1450, penalties: 210 })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('hits')
    expect(fetchedUrl).toContain('penalties')
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

describe('GET /team-seasons/compare-teams', () => {
  it('400s unless exactly two teams and a season are given', async () => {
    const env = makeEnv()
    const noSeason = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR')
    )
    expect(noSeason.status).toBe(400)

    const oneTeam = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR&season=20252026')
    )
    expect(oneTeam.status).toBe(400)

    const threeTeams = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR,BOS&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR,BOS&season=20252026')
    )
    expect(threeTeams.status).toBe(400)
  })

  it('queries both teams for one season, box-score columns only', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', season: 20252026, games_played: 82, wins: 45, losses: 30, ot_losses: 7, points: 97, goals_for: 260, goals_against: 230, pp_pct: 22.5, pk_pct: 78.3 },
        { team: 'NYR', season: 20252026, games_played: 82, wins: 40, losses: 35, ot_losses: 7, points: 87, goals_for: 240, goals_against: 235, pp_pct: 20.1, pk_pct: 79.0 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR&season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body.map(r => r.team)).toEqual(['CAR', 'NYR'])

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=in.(CAR,NYR)')
    expect(fetchedUrl).toContain('season=eq.20252026')
    expect(fetchedUrl).toContain('game_type=eq.2')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ team: 'CAR', season: 20252026, wins: 45 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /team-seasons/head-to-head', () => {
  it('400s unless exactly two teams are given', async () => {
    const env = makeEnv()
    const oneTeam = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR')
    )
    expect(oneTeam.status).toBe(400)

    const threeTeams = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR,BOS'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR,BOS')
    )
    expect(threeTeams.status).toBe(400)
  })

  it('computes all-time record, recent window, and current streak from team A\'s perspective', async () => {
    const env = makeEnv()
    // 5 meetings, chronological -- CAR won games 1,2, lost 3, won 4,5.
    // Current streak: 2 straight CAR wins (games 4,5). Window is
    // min(10,5)=5, so recentWindow equals the all-time record here.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { game_id: 1, season: 20232024, game_date: '2023-11-01', team_score: 4, opp_score: 2, home_team: true },
        { game_id: 2, season: 20232024, game_date: '2024-01-10', team_score: 3, opp_score: 1, home_team: false },
        { game_id: 3, season: 20242025, game_date: '2024-11-05', team_score: 1, opp_score: 5, home_team: true },
        { game_id: 4, season: 20252026, game_date: '2025-11-01', team_score: 2, opp_score: 0, home_team: false },
        { game_id: 5, season: 20252026, game_date: '2026-01-15', team_score: 6, opp_score: 3, home_team: true },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.teamA).toBe('CAR')
    expect(body.teamB).toBe('NYR')
    expect(body.totalMeetings).toBe(5)
    expect(body.allTimeRecord).toEqual({ teamAWins: 4, teamBWins: 1 })
    expect(body.recentWindow).toEqual({ size: 5, teamAWins: 4, teamBWins: 1 })
    expect(body.currentStreak).toEqual({ holder: 'A', count: 2 })
    expect(body.isThinSample).toBe(false)
    expect(body.games).toHaveLength(5)

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=eq.CAR')
    expect(fetchedUrl).toContain('opponent=eq.NYR')
    expect(fetchedUrl).not.toContain('game_type=')
    expect(fetchedUrl).not.toContain('season=eq.')
  })

  it('flags a thin sample and reports zero meetings without erroring', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=DET,SEA'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=DET,SEA')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalMeetings).toBe(0)
    expect(body.currentStreak).toBeNull()
    expect(body.isThinSample).toBe(false)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedPayload = { teamA: 'CAR', teamB: 'NYR', totalMeetings: 5 }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedPayload) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedPayload)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('POST /team-seasons/head-to-head/narrative', () => {
  const basePayload = {
    teamA: 'CAR', teamB: 'NYR', teamADisplay: 'Carolina Hurricanes', teamBDisplay: 'New York Rangers',
    totalMeetings: 5,
    allTimeRecord: { teamAWins: 4, teamBWins: 1 },
    recentWindow: { size: 5, teamAWins: 4, teamBWins: 1 },
    currentStreak: { holder: 'A', count: 2 },
    isThinSample: false,
  }

  it('returns a null narrative without calling the AI model when there are zero meetings', async () => {
    const env = makeEnv({ AI: { run: vi.fn() } })
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: { ...basePayload, totalMeetings: 0 } }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).narrative).toBeNull()
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('returns an error on invalid JSON body', async () => {
    const env = makeEnv()
    const req = new Request('https://example.com/team-seasons/head-to-head/narrative', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    const res = await handleNHL(req, env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative'))
    expect((await res.json()).error).toMatch(/invalid json/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { narrative: 'cached narrative' }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'nhl:h2h-narrative:CAR,NYR' ? JSON.stringify(cached) : null }, async put() {} }, AI: { run: vi.fn() } })
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: basePayload }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(await res.json()).toEqual(cached)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('generates and caches a narrative, sorting the cache key regardless of team order', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Carolina leads this series.' }) } })
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: basePayload }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.narrative).toBe('Carolina leads this series.')
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await env.CACHE.get('nhl:h2h-narrative:CAR,NYR')).narrative).toBe('Carolina leads this series.')
  })

  it('includes a thin-sample guardrail note in the prompt when isThinSample is true', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Too early to say much.' }) } })
    await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: { ...basePayload, totalMeetings: 2, isThinSample: true } }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    const prompt = env.AI.run.mock.calls[0][1].messages[0].content
    expect(prompt).toMatch(/too small a sample/i)
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

// Regression coverage for the 2026-07 multi-team poll-loop rewrite: poll()
// used to only ever fetch CAR's own schedule and could only ever detect
// CAR's own live/just-ended game, so push notifications never fired for
// any other team's subscribers, no matter what they'd subscribed to. It
// now fetches the league-wide /score/now scoreboard and processes every
// live/completed game, dual-broadcasting to both teams playing (mirroring
// pollPWHLGame's pattern in pwhl.js) instead of framing everything as
// "CAR" vs "opponent". sendPush is mocked (see top of file) so these
// assert on *who* got notified, not on real push-service delivery.
describe('poll() — multi-team dual broadcast', () => {
  // The file-level resolveNHLSeason mock returns a fixed 20252026, whose
  // computed season-end (2026-07-01) is now in the past relative to
  // whenever this suite actually runs -- poll() no-ops immediately in that
  // case (see its "Season over" early return). Override to a season safely
  // in the future so poll() actually runs its body in these tests.
  beforeEach(() => {
    const nextYear = new Date().getFullYear() + 2
    vi.mocked(resolveNHLSeason).mockResolvedValue(Number(`${nextYear - 1}${nextYear}`))
  })

  // mockResolvedValue (not -Once) persists past this describe block's own
  // tests since resolveNHLSeason is a shared module-level mock -- restore
  // the file's default so later describe blocks (which assume 20252026,
  // e.g. for their `schedule:CAR:20252026`-shaped cache keys) aren't
  // silently broken by this one.
  afterEach(() => {
    vi.mocked(resolveNHLSeason).mockResolvedValue(20252026)
  })

  function subFor(teamAbbr, endpoint) {
    return { endpoint, keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `NHL:${teamAbbr}` }
  }

  function mockScoreboardAndPbp({ liveGames = [], completedGames = [], pbpByGameId = {} }) {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('/score/now')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [...liveGames, ...completedGames] }) })
      }
      if (u.includes('/play-by-play')) {
        const gid = u.match(/gamecenter\/(\d+)\//)?.[1]
        return Promise.resolve({ ok: true, json: async () => pbpByGameId[gid] || { plays: [] } })
      }
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [] }) })
      }
      // boxscore, standings, team/summary, odds, news — not under test here
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  }

  it('dual-broadcasts a goal to both teams playing, not just this app\'s own team', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('BOS', 'https://push.example/bos-fan'), subFor('CAR', 'https://push.example/car-fan')],
      }),
    })

    const liveGame = {
      id: 2025020555, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 6, abbrev: 'BOS', score: 1 },
      awayTeam: { id: 12, abbrev: 'CAR', score: 0 },
    }
    mockScoreboardAndPbp({
      liveGames: [liveGame],
      pbpByGameId: {
        '2025020555': {
          periodDescriptor: { number: 1 },
          plays: [{
            typeDescKey: 'goal',
            details: { eventOwnerTeamId: 6, scoringPlayerName: 'David Pastrnak', scoringPlayerId: 88, shotType: 'wrist' },
          }],
        },
      },
    })

    await poll(env, makeCtx())

    const calls = sendPushMock.mock.calls
    const bosCalls = calls.filter(([sub]) => sub.endpoint.includes('bos-fan'))
    const carCalls = calls.filter(([sub]) => sub.endpoint.includes('car-fan'))
    expect(bosCalls.length).toBeGreaterThan(0)
    expect(carCalls.length).toBeGreaterThan(0)

    const bosGoalCall = bosCalls.find(([, payload]) => payload.tag?.startsWith('goal-'))
    const carOppGoalCall = carCalls.find(([, payload]) => payload.tag?.startsWith('opp-goal-'))
    expect(bosGoalCall?.[1].title).toContain('GOAL')
    expect(bosGoalCall?.[1].title).toContain('BOS')
    expect(carOppGoalCall?.[1].title).toContain('BOS scores')
  })

  it('dual-broadcasts game-over win/loss for a game involving neither team as this app\'s own default team', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('TOR', 'https://push.example/tor-fan'), subFor('NYR', 'https://push.example/nyr-fan')],
      }),
    })

    const finalGame = {
      id: 2025020777, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-15',
      homeTeam: { id: 10, abbrev: 'TOR', score: 4 },
      awayTeam: { id: 3,  abbrev: 'NYR', score: 2 },
    }
    mockScoreboardAndPbp({ completedGames: [finalGame] })

    await poll(env, makeCtx())

    const calls = sendPushMock.mock.calls
    const torWin  = calls.find(([sub, payload]) => sub.endpoint.includes('tor-fan') && payload.tag?.startsWith('win-'))
    const nyrLoss = calls.find(([sub, payload]) => sub.endpoint.includes('nyr-fan') && payload.tag?.startsWith('final-'))
    expect(torWin?.[1].title).toContain('TOR')
    expect(nyrLoss?.[1].title).toContain('NYR')
  })

  it('does not call generateGameSummary/AI for a completed game that does not involve CAR', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({ 'push:subs': [] }),
    })
    const aiSpy = env.AI.run
    const finalGame = {
      id: 2025020888, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-16',
      homeTeam: { id: 10, abbrev: 'TOR', score: 4 },
      awayTeam: { id: 3,  abbrev: 'NYR', score: 2 },
    }
    mockScoreboardAndPbp({ completedGames: [finalGame] })

    await poll(env, makeCtx())

    expect(aiSpy).not.toHaveBeenCalled()
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

  // ── Combined Prediction Calibration (2026-07) ──────────────────────
  // Regime split: standings pinned to last season -> preseason fallback
  // (prior-season scorecard + continuity dampening); real current-season
  // standings -> existing scorecard + isotonic calibration. Never both.
  // See COMBINED_CALIBRATION_IMPLEMENTATION.md / TRUE_PRESEASON_BACKTEST_RESULTS.md.

  function mockSupabaseByTable(responses) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      for (const [match, rows] of Object.entries(responses)) {
        if (u.includes(match)) return Promise.resolve({ ok: true, json: async () => rows })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })
  }

  it('routes to the preseason fallback (prior-season scorecard + continuity dampening) instead of erroring when standings are still pinned to last season', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    // resolveNHLSeason is mocked to 20252026 above; standings still carrying
    // last season's seasonId is exactly the "NHL's /standings/now hasn't
    // caught up yet" preseason state -- prior season is 20242025.
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20242025, gamesPlayed: 82, points: 90 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: vi.fn().mockResolvedValue({ response: 'Preseason take.' }) },
    })
    mockSupabaseByTable({
      // CAR wins points/GA/PP, BOS wins GF/SF -- a non-degenerate split
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: 24, shots_for_pg: 28 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 20, shots_for_pg: 31 },
      ],
      'players?': [
        { id: 1, team: 'CAR' }, { id: 2, team: 'CAR' }, { id: 3, team: 'BOS' },
      ],
      'player_seasons': [
        { player_id: 1, team: 'CAR', games_played: 82, toi_per_game: 1200 },
        { player_id: 99, team: 'CAR', games_played: 82, toi_per_game: 900 }, // traded away, not on current roster
        { player_id: 3, team: 'BOS', games_played: 82, toi_per_game: 1000 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regime).toBe('preseason')
    expect(body.correction).toBe('continuity-dampened')
    expect(body.isFallback).toBe(true)
    expect(body.dataSeason).toBe(20242025)
    // CAR continuity: player 1 retained (98,400 of 172,200 prior TOI) = 0.5714...
    expect(body.continuity.car).toBeCloseTo(0.5714, 3)
    // BOS continuity: only prior player (3) still on roster = 1.0
    expect(body.continuity.opp).toBeCloseTo(1.0, 3)
    // raw fraction 1.25/2.35 = 0.53191..., dampened by avg continuity 0.7857
    // -> 0.5 + (0.53191-0.5)*0.7857 = 0.52507 -> rounds to 53
    expect(body.carWinPct).toBe(53)
    expect(body.h2hRecord).toMatch(/no games played yet/i)
    expect(body.narrative).toBe('Preseason take.')
    // No team's prediction ever hits both corrections -- the regime check
    // above is a hard early-return in nhl.js, and this test's own
    // correction: 'continuity-dampened' assertion together with the
    // in-season happy-path test's correction: 'isotonic-calibrated'
    // assertion below are mutually exclusive by construction, not just by
    // reading the source.
  })

  it('returns an error rather than guessing when neither team has prior-season team_seasons data', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: vi.fn().mockResolvedValue({ response: 'should not be called' }) },
    })
    mockSupabaseByTable({ 'team_seasons': [] })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect((await res.json()).error).toMatch(/no prior-season.*data available/i)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('defaults a missing prior-season pp_pct to league-average (22%) identically in scoring and the AI prompt text', async () => {
    // Regression for a real bug: scoring used to default a missing pp_pct
    // to 22 (`?? 22`) while the prompt text separately defaulted to 0
    // (`?? 0`) -- same missing-data case, two different silent defaults,
    // so the model scored a team as league-average while telling the AI
    // narrative generator it was shut out on the power play. Both paths
    // now resolve the default once (PP_PCT_DEFAULT) and share it.
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20242025, gamesPlayed: 82, points: 90 },
    ]
    const aiRun = vi.fn().mockResolvedValue({ response: 'Preseason take.' })
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: aiRun },
    })
    mockSupabaseByTable({
      // CAR's pp_pct is missing entirely -- the UTA-shaped gap
      // (backfill_uta_2025_team_stats.py) this test is modeled on.
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: null, shots_for_pg: 28 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 21, shots_for_pg: 31 },
      ],
      'players?': [
        { id: 1, team: 'CAR' }, { id: 2, team: 'CAR' }, { id: 3, team: 'BOS' },
      ],
      'player_seasons': [
        { player_id: 1, team: 'CAR', games_played: 82, toi_per_game: 1200 },
        { player_id: 99, team: 'CAR', games_played: 82, toi_per_game: 900 },
        { player_id: 3, team: 'BOS', games_played: 82, toi_per_game: 1000 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // Scoring: carPP (defaulted to 22) > oppPP (21) -- CAR gets the PP%
    // point, same as if a real pp_pct > 21 had been stored. ptsDiff(+0.25)
    // + GA(+0.6) + PP(+0.4) = 1.25 for CAR vs. GF(+0.6) + SF(+0.5) = 1.1
    // for BOS; total 2.35, raw fraction 0.531914..., dampened by the same
    // 0.785714 avg continuity as the sibling preseason test -> 53.
    expect(body.carWinPct).toBe(53)
    // Prompt text: both teams' PP% lines use the same 22.0% default CAR's
    // missing value resolved to -- not a separate, disagreeing 0.0%.
    const promptSent = aiRun.mock.calls[0][1].messages[0].content
    expect(promptSent).toMatch(/CAR last season \(\d+\): 100 pts, GF\/GA per game: 3\.00 \/ 2\.80, PP%: 22\.0%/)
    expect(promptSent).not.toMatch(/CAR.*PP%: 0\.0%/)
  })

  it('does not treat a standings feed with no seasonId as stale (e.g. a test stub)', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 10, wins: 7, losses: 3, otLosses: 0, points: 14, goalFor: 35, goalAgainst: 25, powerPlayPct: 24, penaltyKillPct: 80, shotsForPerGame: 32, shotsAgainstPerGame: 28, streakCode: 'W', streakCount: 3 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 28, goalAgainst: 30, powerPlayPct: 18, penaltyKillPct: 76, shotsForPerGame: 29, shotsAgainstPerGame: 31, streakCode: 'L', streakCount: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: vi.fn().mockResolvedValue({ response: 'CAR should win this one comfortably.' }) },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).narrative).toBe('CAR should win this one comfortably.')
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
    // CAR wins every scorecard factor here -> raw fraction is exactly 1.0
    // (would have been carWinPct: 100 pre-calibration). Isotonic clips
    // x=1.0 to the fitted curve's top y-threshold (0.68888..., refit
    // 2026-07-24 against corrected game_log pp_goals/pp_opps -- see
    // ISOTONIC_RECALIBRATION_CADENCE.md), landing on 69 -- a concrete
    // demonstration that the calibration fix is wired in, not just
    // present in the source.
    expect(body.carWinPct).toBe(69)
    expect(body.regime).toBe('in-season')
    expect(body.correction).toBe('isotonic-calibrated')

    const cached = JSON.parse(await env.CACHE.get('prediction:123'))
    expect(cached.narrative).toBe('CAR should win this one comfortably.')
  })

  it('defaults a missing in-season powerPlayPct to league-average (22%) identically in scoring and the AI prompt text', async () => {
    // Same disagreement bug as buildPreseasonFallback's pp_pct default
    // (see the sibling test above), fixed the same way in this branch:
    // scoring already defaulted a missing powerPlayPct to 22, but the
    // prompt text separately defaulted to 0. Both now share PP_PCT_DEFAULT.
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      // Every other scorecard factor tied (points, GF/GA, SOG, no streak)
      // so PP% is the only thing that can move carScore off 0 -- isolates
      // the default's effect precisely.
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 30, goalAgainst: 30, powerPlayPct: null, penaltyKillPct: 80, shotsForPerGame: 30, shotsAgainstPerGame: 30 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 30, goalAgainst: 30, powerPlayPct: 21, penaltyKillPct: 76, shotsForPerGame: 30, shotsAgainstPerGame: 30 },
    ]
    const aiRun = vi.fn().mockResolvedValue({ response: 'In-season take.' })
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
      AI: { run: aiRun },
    })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // carPP defaults to 22 > oppPP 21 -- CAR gets the sole 0.4 scoring
    // point (every other factor tied to oppScore per the strict >/< ties
    // going to else). carScore=0.4, oppScore=1.7 (GF tie 0.6 + GA tie 0.6
    // + SOG tie 0.5), raw fraction 0.4/2.1=0.190476 -- lands in the fitted
    // isotonic curve's flat plateau (0.166667-0.483871, both endpoints
    // 0.523622), so carWinPct = round(52.3622) = 52 regardless of small
    // float drift within that plateau.
    expect(body.carWinPct).toBe(52)
    expect(body.regime).toBe('in-season')
    const promptSent = aiRun.mock.calls[0][1].messages[0].content
    expect(promptSent).toMatch(/CAR stats:[\s\S]*PP%: 22\.0%/)
    expect(promptSent).not.toMatch(/CAR stats:[\s\S]{0,120}PP%: 0\.0%/)
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

// ── Odds Persistence Writer (2026-07) ──────────────────────────────────
// fetchOdds() had zero test coverage before this change (see
// ODDS_PERSISTENCE_WRITER_SCOPE.md) -- it ran off the same 60s poll tick
// as everything else, writing to a KV key nothing read back. These cover
// the redesigned throttle (safety-net + pregame-proximity) and the new
// Supabase persistence, through poll()'s real execution rather than by
// exporting fetchOdds()'s internals, matching this file's existing
// "test through the public surface" convention.
describe('fetchOdds() — Odds Persistence Writer', () => {
  const HOUR = 3_600_000

  beforeEach(() => {
    // Same override as the "poll() — multi-team dual broadcast" block above
    // -- resolveNHLSeason's file-level mock season-end is in the past by
    // now, which would make poll() no-op immediately otherwise.
    const nextYear = new Date().getFullYear() + 2
    vi.mocked(resolveNHLSeason).mockResolvedValue(Number(`${nextYear - 1}${nextYear}`))
  })
  afterEach(() => {
    vi.mocked(resolveNHLSeason).mockResolvedValue(20252026)
  })

  function mockFetchForOdds({ scheduleGames = [], scoreboardGames = [], oddsResponse = [], oddsStatus = 200 }) {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('/score/now')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: scoreboardGames }) })
      }
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: scheduleGames }) })
      }
      if (u.includes('the-odds-api.com')) {
        return Promise.resolve({ ok: oddsStatus === 200, status: oddsStatus, json: async () => oddsResponse })
      }
      if (u.includes('/rest/v1/nhl_odds')) {
        return Promise.resolve({ ok: true, json: async () => [] })
      }
      // boxscore, standings, team/summary, news, etc. — not under test here
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  }

  const scheduleGameIn = (days) => ({
    id: 1, gameType: 2,
    startTimeUTC: new Date(Date.now() + days * 24 * HOUR).toISOString(),
    homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'BOS' },
  })

  it('skips entirely when no games are within the 7-day window (unchanged gate)', async () => {
    const env = makeEnv({ ODDS_API_KEY: 'test-odds-key' })
    mockFetchForOdds({ scheduleGames: [], scoreboardGames: [] })

    await poll(env, makeCtx())

    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('the-odds-api.com'))).toBe(false)
  })

  it('fetches and persists odds on the safety-net path when nothing has been fetched yet', async () => {
    const env = makeEnv({ ODDS_API_KEY: 'test-odds-key' })
    const oddsResponse = [{
      home_team: 'Carolina Hurricanes', away_team: 'Boston Bruins', commence_time: '2026-10-05T23:00:00Z',
      bookmakers: [{
        key: 'draftkings', title: 'DraftKings',
        markets: [{ key: 'h2h', outcomes: [
          { name: 'Carolina Hurricanes', price: -150 },
          { name: 'Boston Bruins', price: 130 },
        ] }],
      }],
    }]
    mockFetchForOdds({ scheduleGames: [scheduleGameIn(3)], scoreboardGames: [], oddsResponse })

    await poll(env, makeCtx())

    const upsertCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('/rest/v1/nhl_odds'))
    expect(upsertCall).toBeDefined()
    const [upsertUrl, init] = upsertCall
    expect(String(upsertUrl)).toContain('on_conflict=season,home_abbr,away_abbr,commence_time')
    const body = JSON.parse(init.body)
    expect(body).toEqual([{
      season: expect.any(Number),
      home_abbr: 'CAR',
      away_abbr: 'BOS',
      commence_time: '2026-10-05T23:00:00Z',
      moneyline_home: -150,
      moneyline_away: 130,
      book: 'DraftKings',
      fetched_at: expect.any(String),
    }])
  })

  it('does not re-fetch when recently fetched and no game is starting soon (throttled)', async () => {
    const env = makeEnv({
      ODDS_API_KEY: 'test-odds-key',
      CACHE: makeFakeCache({ 'odds:lastFetchedAt': Date.now() - 1 * HOUR }), // below both the 3h and 12h thresholds
    })
    mockFetchForOdds({ scheduleGames: [scheduleGameIn(3)], scoreboardGames: [] })

    await poll(env, makeCtx())

    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('the-odds-api.com'))).toBe(false)
  })

  it('fetches again when a game is starting within the pregame window, even though the 12h safety net has not elapsed', async () => {
    const soonGame = {
      id: 2, gameState: 'FUT',
      startTimeUTC: new Date(Date.now() + 2 * HOUR).toISOString(),
      homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'BOS' },
    }
    const env = makeEnv({
      ODDS_API_KEY: 'test-odds-key',
      // 4h ago -- past the 3h pregame threshold, well under the 12h safety net,
      // so only the pregame-proximity path (not the safety net) explains a fetch here.
      CACHE: makeFakeCache({ 'odds:lastFetchedAt': Date.now() - 4 * HOUR }),
    })
    mockFetchForOdds({ scheduleGames: [scheduleGameIn(3)], scoreboardGames: [soonGame], oddsResponse: [] })

    await poll(env, makeCtx())

    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('the-odds-api.com'))).toBe(true)
  })

  it('backs off for 6h on a 401 without persisting anything', async () => {
    const env = makeEnv({ ODDS_API_KEY: 'test-odds-key' })
    mockFetchForOdds({ scheduleGames: [scheduleGameIn(3)], scoreboardGames: [], oddsStatus: 401 })

    await poll(env, makeCtx())

    expect(JSON.parse(await env.CACHE.get('odds:backoff'))).toBe(1)
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('/rest/v1/nhl_odds'))).toBe(false)
  })
})

describe('GET /nhl/odds', () => {
  it('reads from the persisted nhl_odds table, already flattened by team abbr', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { home_abbr: 'CAR', away_abbr: 'BOS', commence_time: '2026-10-05T23:00:00Z', moneyline_home: -150, moneyline_away: 130, book: 'DraftKings' },
      ],
    })

    const res = await handleNHL(makeRequest('/nhl/odds'), env, makeCtx(), new URL('https://example.com/nhl/odds'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([
      { home_abbr: 'CAR', away_abbr: 'BOS', commence_time: '2026-10-05T23:00:00Z', moneyline_home: -150, moneyline_away: 130, book: 'DraftKings' },
    ])
  })

  it('serves from the 5min edge cache without re-querying Supabase', async () => {
    const cached = [{ home_abbr: 'CAR', away_abbr: 'BOS', commence_time: '2026-10-05T23:00:00Z', moneyline_home: -150, moneyline_away: 130, book: 'DraftKings' }]
    const env = makeEnv({ CACHE: makeFakeCache({ 'nhl:odds:20252026': cached }) })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/nhl/odds'), env, makeCtx(), new URL('https://example.com/nhl/odds'))

    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns an empty array rather than erroring when the Supabase query fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(makeRequest('/nhl/odds'), env, makeCtx(), new URL('https://example.com/nhl/odds'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
