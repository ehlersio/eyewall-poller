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
import { makeEnv, makeCtx, makeRequest, makeFakeCache, makeFakeRateLimiter } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
  getAllPWHLSeasonTypes: vi.fn().mockResolvedValue({ 8: 'regular', 9: 'playoffs' }),
}))

import { getAllPWHLSeasonTypes } from '../seasons.js'

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

describe('GET /pwhl/team-season-summary', () => {
  it('400s when teamId is missing', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/team-season-summary?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-season-summary?season=8')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cached = { teamId: 1, season: 8, gamesPlayed: 1, sog: { car: 1, opp: 0 } }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cached) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-season-summary?teamId=1&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-season-summary?teamId=1&season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns a zeroed response when the team has no completed games this season', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-season-summary?teamId=1&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-season-summary?teamId=1&season=8')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ teamId: 1, season: 8, gamesPlayed: 0, sog: { car: 0, opp: 0 } })
  })

  // team_id=1 is "car" throughout this test; team_id=2 is "opp".
  it('aggregates SOG/blocks/hits/penalties/faceoffs by team_id across the team\'s own games, plus season PP%/PK%', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('pwhl_game_log')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 100 }, { game_id: 101 }] })
      }
      if (u.includes('pwhl_shot_events')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { team_id: 1, event_type: 'shot' },       // car SOG
            { team_id: 1, event_type: 'goal' },        // car SOG
            { team_id: 2, event_type: 'shot' },        // opp SOG
            { team_id: 1, event_type: 'blocked_shot' }, // car's own shot blocked
            { team_id: 2, event_type: 'blocked_shot' }, // opp's own shot blocked
            { team_id: 2, event_type: 'blocked_shot' }, // opp's own shot blocked
          ],
        })
      }
      if (u.includes('pwhl_pbp_events')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { team_id: 1, event_type: 'hit' },
            { team_id: 1, event_type: 'hit' },
            { team_id: 2, event_type: 'hit' },
            { team_id: 2, event_type: 'penalty' },
            { team_id: 1, event_type: 'faceoff' }, // car won
            { team_id: 1, event_type: 'faceoff' }, // car won
            { team_id: 2, event_type: 'faceoff' }, // opp won
          ],
        })
      }
      if (u.includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ pp_pct: 21.5, pk_pct: 81.2 }] })
      }
      return Promise.resolve({ ok: false, status: 500 })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-season-summary?teamId=1&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-season-summary?teamId=1&season=8')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      teamId: 1, season: 8, gamesPlayed: 2,
      sog: { car: 2, opp: 1 },
      blocked: { car: 1, opp: 2 },
      hits: { car: 2, opp: 1 },
      penalties: { car: 0, opp: 1 },
      faceoff: { car: 2, opp: 1, pct: (2 / 3) * 100 },
      ppPct: 21.5, pkPct: 81.2,
    })
  })

  it('502s when the shot_events fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('pwhl_game_log')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 100 }] })
      }
      return Promise.resolve({ ok: false, status: 503 })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-season-summary?teamId=1&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-season-summary?teamId=1&season=8')
    )

    expect(res.status).toBe(502)
  })
})

describe('GET /pwhl/team-seasons/compare', () => {
  it('400s when teamId or seasons is missing', async () => {
    const env = makeEnv()
    const noTeam = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare?seasons=8,5'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare?seasons=8,5')
    )
    expect(noTeam.status).toBe(400)

    const noSeasons = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare?teamId=2'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare?teamId=2')
    )
    expect(noSeasons.status).toBe(400)
  })

  it('queries box-score columns only (not corsi_for/roster_war_score) for the given team + season_id list', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { season_id: 8, season_type: 'regular', gp: 24, wins: 15, losses: 7, ot_losses: 2, points: 32, goals_for: 70, goals_against: 55, pp_pct: 20.1, pk_pct: 82.4 },
        { season_id: 5, season_type: 'regular', gp: 24, wins: 12, losses: 10, ot_losses: 2, points: 26, goals_for: 60, goals_against: 62, pp_pct: 18.5, pk_pct: 79.0 },
      ],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare?teamId=2&seasons=8,5'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare?teamId=2&seasons=8,5')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ season_id: 8, wins: 15, points: 32 })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team_id=eq.2')
    expect(fetchedUrl).toContain('season_id=in.(8,5)')
    expect(fetchedUrl).toContain('goals_for')
    expect(fetchedUrl).toContain('pp_pct')
    expect(fetchedUrl).not.toContain('corsi_for')
    expect(fetchedUrl).not.toContain('roster_war_score')
  })

  it('returns 502 when the Supabase fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare?teamId=2&seasons=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare?teamId=2&seasons=8')
    )

    expect(res.status).toBe(502)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ season_id: 8, wins: 15 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare?teamId=2&seasons=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare?teamId=2&seasons=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /pwhl/team-seasons/compare-teams', () => {
  it('400s unless exactly two teamIds and a season are given', async () => {
    const env = makeEnv()
    const noSeason = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare-teams?teamIds=2,3'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare-teams?teamIds=2,3')
    )
    expect(noSeason.status).toBe(400)

    const oneTeam = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare-teams?teamIds=2&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare-teams?teamIds=2&season=8')
    )
    expect(oneTeam.status).toBe(400)
  })

  it('queries both team_ids for one season_id, box-score columns only', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team_id: 2, season_id: 8, season_type: 'regular', gp: 24, wins: 15, losses: 7, ot_losses: 2, points: 32, goals_for: 70, goals_against: 55, pp_pct: 20.1, pk_pct: 82.4 },
        { team_id: 3, season_id: 8, season_type: 'regular', gp: 24, wins: 10, losses: 12, ot_losses: 2, points: 22, goals_for: 55, goals_against: 68, pp_pct: 15.0, pk_pct: 76.0 },
      ],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare-teams?teamIds=2,3&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare-teams?teamIds=2,3&season=8')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body.map(r => r.team_id)).toEqual([2, 3])

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team_id=in.(2,3)')
    expect(fetchedUrl).toContain('season_id=eq.8')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ team_id: 2, season_id: 8, wins: 15 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/team-seasons/compare-teams?teamIds=2,3&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/team-seasons/compare-teams?teamIds=2,3&season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /pwhl/game-box', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const cached = { skaters: [{ game_id: 210, player_id: 1, team_id: 1 }], goalies: [] }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cached) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/game-box?gameId=210'), env, makeCtx(),
      new URL('https://example.com/pwhl/game-box?gameId=210')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches skaters + goalies in parallel on a cache miss and returns them together', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_skater_game_box')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 210, player_id: 1, team_id: 1, goals: 2 }] })
      }
      if (String(url).includes('pwhl_goalie_game_box')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 210, player_id: 99, team_id: 2, saves: 30 }] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/game-box?gameId=210'), env, makeCtx(),
      new URL('https://example.com/pwhl/game-box?gameId=210')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      skaters: [{ game_id: 210, player_id: 1, team_id: 1, goals: 2 }],
      goalies: [{ game_id: 210, player_id: 99, team_id: 2, saves: 30 }],
    })
  })

  it('returns 400 when gameId is missing', async () => {
    const env = makeEnv()

    const res = await handlePWHL(
      makeRequest('/pwhl/game-box'), env, makeCtx(),
      new URL('https://example.com/pwhl/game-box')
    )

    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 502 when the skater fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_skater_game_box')) {
        return Promise.resolve({ ok: false, status: 503 })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/game-box?gameId=210'), env, makeCtx(),
      new URL('https://example.com/pwhl/game-box?gameId=210')
    )

    expect(res.status).toBe(502)
  })

  it('returns 502 when the goalie fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_goalie_game_box')) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/game-box?gameId=210'), env, makeCtx(),
      new URL('https://example.com/pwhl/game-box?gameId=210')
    )

    expect(res.status).toBe(502)
  })
})

describe('GET /pwhl/player-game-log', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const cached = { skaters: [{ game_id: 210, player_id: 62, season_id: 8, goals: 1 }], goalies: [] }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cached) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?playerId=62&seasonId=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?playerId=62&seasonId=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches skaters + goalies in parallel on a cache miss and returns them together', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_skater_game_box')) {
        expect(String(url)).toContain('player_id=eq.62')
        expect(String(url)).toContain('season_id=eq.8')
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 210, player_id: 62, season_id: 8, goals: 1 }] })
      }
      if (String(url).includes('pwhl_goalie_game_box')) {
        return Promise.resolve({ ok: true, json: async () => [] })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?playerId=62&seasonId=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?playerId=62&seasonId=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      skaters: [{ game_id: 210, player_id: 62, season_id: 8, goals: 1 }],
      goalies: [],
    })
  })

  it('returns 400 when playerId is missing', async () => {
    const env = makeEnv()

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?seasonId=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?seasonId=8')
    )

    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 400 when seasonId is missing', async () => {
    const env = makeEnv()

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?playerId=62'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?playerId=62')
    )

    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 502 when the skater fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_skater_game_box')) {
        return Promise.resolve({ ok: false, status: 503 })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?playerId=62&seasonId=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?playerId=62&seasonId=8')
    )

    expect(res.status).toBe(502)
  })

  it('returns 502 when the goalie fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_goalie_game_box')) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player-game-log?playerId=62&seasonId=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player-game-log?playerId=62&seasonId=8')
    )

    expect(res.status).toBe(502)
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

// ── /pwhl/preview + /pwhl/prediction (Session 51) ────────────────────────────

describe('GET /pwhl/preview', () => {
  it('400s when gameId is missing', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/preview'), env, makeCtx(), new URL('https://example.com/pwhl/preview')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache without hitting HockeyTech', async () => {
    const cached = { gameId: 210, homeTeam: null }
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:preview:210': cached }) })
    const res = await handlePWHL(
      makeRequest('/pwhl/preview?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/preview?gameId=210')
    )
    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('normalizes a live gameCenterPreview payload on a cache miss', async () => {
    const env = makeEnv()
    const htPayload = {
      homeTeam: {
        teamInfo: { id: '3', abbreviation: 'MTL', name: 'Montreal Victoire' },
        goalsFor: 45, goalsAgainst: 30,
        teamRecord: { streak: '3-0-0', overall: { formattedRecord: '10-2-0' }, past_10_games: { formattedRecord: '8-2-0' } },
        leadingScorers: [{ info: { firstName: 'Marie-Philip', lastName: 'Poulin' }, stats: { points: 20 } }],
        leadingRookie: null,
        leadingPIM: null,
        powerPlayStats: { overall: { pct: '22.0' } },
        penaltyKillStats: { overall: { pct: '85.0' } },
        longestStreaks: { points: [{ player: 'Poulin', streak: 3, length: 3 }] },
      },
      visitingTeam: {
        teamInfo: { id: '5', abbreviation: 'OTT', name: 'Ottawa Charge' },
        goalsFor: 30, goalsAgainst: 40,
        teamRecord: { streak: '0-3-0', overall: { formattedRecord: '4-8-0' }, past_10_games: { formattedRecord: '2-8-0' } },
        leadingScorers: [],
        leadingRookie: null,
        leadingPIM: null,
        powerPlayStats: { overall: { pct: '15.0' } },
        penaltyKillStats: { overall: { pct: '78.0' } },
        longestStreaks: { points: [] },
      },
      previousMeetings: [{ gameId: '150', datePlayed: '2026-05-01', homeTeamId: '3', homeCity: 'Montreal', homeScore: '4', visitingTeamId: '5', visitingCity: 'Ottawa', visitingScore: '2' }],
      headToHeadRecords: { homeTeam: { previousFiveYears: { formattedRecord: '6-2-0' } }, visitingTeam: { previousFiveYears: { formattedRecord: '2-6-0' } } },
    }
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(htPayload) })

    const res = await handlePWHL(
      makeRequest('/pwhl/preview?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/preview?gameId=210')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.homeTeam).toMatchObject({ id: 3, abbreviation: 'MTL', streak: '3-0-0' })
    expect(body.visitingTeam).toMatchObject({ id: 5, abbreviation: 'OTT' })
    expect(body.seasonSeries).toEqual([{ gameId: 150, datePlayed: '2026-05-01', homeTeamId: 3, homeCity: 'Montreal', homeScore: 4, visitingTeamId: 5, visitingCity: 'Ottawa', visitingScore: 2 }])
    expect(body.headToHeadRecords).toEqual(htPayload.headToHeadRecords)
    expect(body.longestStreaks.home).toEqual(htPayload.homeTeam.longestStreaks)
    // miscellaneousRecords/lineup deliberately excluded
    expect(body.homeTeam.miscellaneousRecords).toBeUndefined()
    expect(body.homeTeam.lineup).toBeUndefined()
  })

  it('502s when the HockeyTech fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    const res = await handlePWHL(
      makeRequest('/pwhl/preview?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/preview?gameId=210')
    )
    expect(res.status).toBe(502)
  })
})

describe('GET /pwhl/prediction', () => {
  // Mocks the 3 Supabase REST calls the route makes, keyed by URL substring:
  // the single-game lookup, the 2-team pwhl_team_seasons pull, and the
  // season-wide Final game log (for streak + this-season H2H).
  function mockSupabaseFlow({ game, teams, seasonGames }) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('pwhl_game_log?game_id=eq.')) {
        return Promise.resolve({ ok: true, json: async () => (game ? [game] : []) })
      }
      if (u.includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => teams })
      }
      if (u.includes('pwhl_game_log?season_id=eq.')) {
        return Promise.resolve({ ok: true, json: async () => seasonGames })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
  }

  const homeTeamRow = { team_id: 3, gp: 10, wins: 8, losses: 2, ot_losses: 0, points: 16, goals_for: 45, goals_against: 25, pp_pct: 0.22, pk_pct: 0.85, corsi_for_pct: 54.2 }
  const awayTeamRow = { team_id: 5, gp: 10, wins: 4, losses: 6, ot_losses: 0, points: 8, goals_for: 25, goals_against: 40, pp_pct: 0.15, pk_pct: 0.78, corsi_for_pct: 46.1 }

  it('400s when gameId is missing', async () => {
    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction'), env, makeCtx(), new URL('https://example.com/pwhl/prediction')
    )
    expect(res.status).toBe(400)
  })

  it('429s when the AI rate limiter rejects', async () => {
    const env = makeEnv({ AI_ROUTE_LIMITER: makeFakeRateLimiter(vi.fn().mockResolvedValue({ success: false })) })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(res.status).toBe(429)
  })

  it('serves from KV cache without calling the AI model', async () => {
    const cached = { gameId: 210, homeWinPct: 60 }
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:prediction:210': cached }) })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(await res.json()).toEqual(cached)
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('404s when the game is not found in pwhl_game_log', async () => {
    const env = makeEnv()
    mockSupabaseFlow({ game: null, teams: [], seasonGames: [] })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=999'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=999')
    )
    expect(res.status).toBe(404)
  })

  it('computes win probability/Corsi/streaks and generates a narrative', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Montreal should win behind their possession edge.' }) } })
    mockSupabaseFlow({
      game: { game_id: 210, season_id: 8, home_team_id: 3, away_team_id: 5 },
      teams: [homeTeamRow, awayTeamRow],
      seasonGames: [
        { game_id: 201, home_team_id: 3, away_team_id: 5, home_score: 4, away_score: 2, ot: false, shootout: false },
        { game_id: 205, home_team_id: 3, away_team_id: 8, home_score: 3, away_score: 1, ot: false, shootout: false },
      ],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.homeAbbr).toBe('MTL')
    expect(body.awayAbbr).toBe('OTT')
    expect(body.isPlayoff).toBe(false)
    expect(body.homeWinPct).toBeGreaterThan(body.awayWinPct) // MTL is better on every input
    expect(body.homeStreak).toBe('W2')
    expect(body.h2hRecord).toBe('1-0')
    expect(body.corsiForPct).toEqual({ home: 54.2, away: 46.1 })
    expect(body.corsiCaveat).toMatch(/not 5-on-5/i)
    expect(body.narrative).toBe('Montreal should win behind their possession edge.')
    expect(JSON.parse(await env.CACHE.get('pwhl:prediction:210')).homeWinPct).toBe(body.homeWinPct)
  })

  it('uses real 5v5 Corsi from pwhl_team_seasons when both teams have it, instead of the all-situations column', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'Montreal has the 5v5 possession edge.' }) } })
    mockSupabaseFlow({
      game: { game_id: 210, season_id: 8, home_team_id: 3, away_team_id: 5 },
      teams: [
        { ...homeTeamRow, corsi_for_pct_5v5: 58.9 },
        { ...awayTeamRow, corsi_for_pct_5v5: 44.3 },
      ],
      seasonGames: [],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    // 5v5 preferred over all-situations (54.2/46.1 on the base fixture rows)
    expect(body.corsiForPct).toEqual({ home: 58.9, away: 44.3 })
    expect(body.corsiCaveat).toMatch(/5-on-5 shot-attempt share/i)
    expect(body.corsiCaveat).not.toMatch(/not 5-on-5/i)
  })

  it('resolves playoff status via getAllPWHLSeasonTypes and skips the points term', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: 'A tight playoff tilt.' }) } })
    mockSupabaseFlow({
      game: { game_id: 300, season_id: 9, home_team_id: 3, away_team_id: 5 },
      teams: [homeTeamRow, awayTeamRow],
      seasonGames: [],
    })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=300'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=300')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).isPlayoff).toBe(true)
    expect(getAllPWHLSeasonTypes).toHaveBeenCalled()
  })

  it('returns an error when the AI response is empty', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockResolvedValue({ response: '' }) } })
    mockSupabaseFlow({
      game: { game_id: 210, season_id: 8, home_team_id: 3, away_team_id: 5 },
      teams: [homeTeamRow, awayTeamRow],
      seasonGames: [],
    })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/empty/i)
  })

  it('502s when the AI call throws', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockRejectedValue(new Error('AI unavailable')) } })
    mockSupabaseFlow({
      game: { game_id: 210, season_id: 8, home_team_id: 3, away_team_id: 5 },
      teams: [homeTeamRow, awayTeamRow],
      seasonGames: [],
    })
    const res = await handlePWHL(
      makeRequest('/pwhl/prediction?gameId=210'), env, makeCtx(), new URL('https://example.com/pwhl/prediction?gameId=210')
    )
    expect(res.status).toBe(502)
  })
})

describe('GET /pwhl/player/landing', () => {
  function mockPlayerFetch({ playerRows, statsRows }) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/rest/v1/pwhl_players?')) {
        return Promise.resolve({ ok: true, json: async () => playerRows })
      }
      // Both pwhl_player_seasons and pwhl_goalie_seasons hit this branch —
      // whichever table statsTable resolves to gets statsRows.
      return Promise.resolve({ ok: true, json: async () => statsRows })
    })
  }

  it('returns 400 when id is missing', async () => {
    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/landing')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache, keyed separately per season, without hitting Supabase', async () => {
    const env = makeEnv({
      CACHE: { async get(key) {
        return key === 'pwhl:player:landing:198:8' ? JSON.stringify({ player_id: 198, points: 40 }) : null
      }, async put() {} },
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing?id=198&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/landing?id=198&season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ player_id: 198, points: 40 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns 404 when the player is not found', async () => {
    mockPlayerFetch({ playerRows: [], statsRows: [] })
    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing?id=999'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/player/landing?id=999')
    )
    expect(res.status).toBe(404)
  })

  it('pins the stat line to the requested season_id and caches per-season', async () => {
    mockPlayerFetch({
      playerRows: [{ player_id: 198, first_name: 'Marie-Philip', last_name: 'Poulin', position: 'F' }],
      statsRows: [{ player_id: 198, season_id: 5, points: 22 }],
    })

    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing?id=198&season=5'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/landing?id=198&season=5')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ player_id: 198, first_name: 'Marie-Philip', points: 22 })

    // The historical-season fetch used season_id=eq., not order=...desc
    const statsCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('pwhl_player_seasons'))
    expect(statsCall[0]).toContain('season_id=eq.5')
    expect(statsCall[0]).not.toContain('order=season_id.desc')

    const cached = await env.CACHE.get('pwhl:player:landing:198:5')
    expect(JSON.parse(cached)).toEqual(body)
  })

  it('falls back to the most recent regular-season row when season is omitted', async () => {
    mockPlayerFetch({
      playerRows: [{ player_id: 198, first_name: 'Marie-Philip', last_name: 'Poulin', position: 'F' }],
      statsRows: [{ player_id: 198, season_id: 8, points: 40 }],
    })

    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing?id=198'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/landing?id=198')
    )

    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ points: 40 })

    const statsCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('pwhl_player_seasons'))
    expect(statsCall[0]).toContain('order=season_id.desc')
    expect(statsCall[0]).not.toContain('season_id=eq.')

    const cached = await env.CACHE.get('pwhl:player:landing:198:latest')
    expect(cached).toBeTruthy()
  })

  it('queries pwhl_goalie_seasons instead of pwhl_player_seasons for goalies', async () => {
    mockPlayerFetch({
      playerRows: [{ player_id: 55, first_name: 'Aerin', last_name: 'Frankel', position: 'G' }],
      statsRows: [{ player_id: 55, season_id: 8, sv_pct: 0.93 }],
    })

    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/player/landing?id=55&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/landing?id=55&season=8')
    )

    expect(res.status).toBe(200)
    expect((await res.json())).toMatchObject({ sv_pct: 0.93 })
    const statsCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('_seasons?'))
    expect(statsCall[0]).toContain('pwhl_goalie_seasons')
  })
})

describe('GET /pwhl/player/percentiles', () => {
  it('returns 400 when id is missing', async () => {
    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/percentiles')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache, keyed per season+seasonType, without hitting Supabase', async () => {
    const env = makeEnv({
      CACHE: { async get(key) {
        return key === 'pwhl:player:percentiles:198:8:regular' ? JSON.stringify({ player_id: 198, xg_for: 12.3 }) : null
      }, async put() {} },
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=198&season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=198&season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ player_id: 198, xg_for: 12.3 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns a clean null-percentiles response (not an error) when no row exists yet', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=999&season=8'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=999&season=8')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      player_id: 999, season_id: 8, season_type: 'regular',
      toi_per_game: null, xg_for: null, finishing: null,
    })
    expect(body.percentiles).toEqual({
      goals:     { pct: null, label: 'Goals',       note: expect.any(String) },
      a1:        { pct: null, label: '1st Assists', note: expect.any(String) },
      penalties: { pct: null, label: 'Penalties',   note: expect.any(String) },
      finishing: { pct: null, label: 'Finishing',   note: expect.any(String) },
    })
  })

  it('returns null percentile fields (not an error) when the row exists but pct_* columns are still null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ player_id: 198, team_id: 3, season_id: 8, season_type: 'regular', toi_per_game: 720, xg_for: null, finishing: null, pct_goals: null, pct_a1: null, pct_penalties: null, pct_finishing: null }],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=198&season=8'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=198&season=8')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.toi_per_game).toBe(720)
    expect(body.percentiles.goals.pct).toBeNull()
    expect(body.percentiles.finishing.pct).toBeNull()
  })

  it('returns populated percentiles for a fully-computed row, pinned to season+seasonType', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        player_id: 198, team_id: 3, season_id: 8, season_type: 'regular',
        toi_per_game: 1080, xg_for: 14.2, finishing: 2.1,
        pct_goals: 92, pct_a1: 78, pct_penalties: 55, pct_finishing: 88,
      }],
    })

    const env = makeEnv()
    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=198&season=8&seasonType=regular'), env, makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=198&season=8&seasonType=regular')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      player_id: 198, team_id: 3, season_id: 8, season_type: 'regular',
      toi_per_game: 1080, xg_for: 14.2, finishing: 2.1,
    })
    expect(body.percentiles.goals.pct).toBe(92)
    expect(body.percentiles.a1.pct).toBe(78)
    expect(body.percentiles.penalties.pct).toBe(55)
    expect(body.percentiles.finishing.pct).toBe(88)

    const statsCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('pwhl_player_seasons'))
    expect(statsCall[0]).toContain('season_id=eq.8')
    expect(statsCall[0]).toContain('season_type=eq.regular')
    expect(statsCall[0]).not.toContain('order=season_id.desc')

    const cached = await env.CACHE.get('pwhl:player:percentiles:198:8:regular')
    expect(JSON.parse(cached)).toEqual(body)
  })

  it('defaults to season_type=regular and the most recent season_id when season is omitted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ player_id: 198, team_id: 3, season_id: 8, season_type: 'regular', pct_goals: 50, pct_a1: 50, pct_penalties: 50, pct_finishing: 50 }],
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=198'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=198')
    )

    expect(res.status).toBe(200)
    const statsCall = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('pwhl_player_seasons'))
    expect(statsCall[0]).toContain('season_type=eq.regular')
    expect(statsCall[0]).toContain('order=season_id.desc')
    expect(statsCall[0]).not.toContain('season_id=eq.')
  })

  it('returns 502 when the Supabase fetch fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/percentiles?id=198&season=8'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/player/percentiles?id=198&season=8')
    )

    expect(res.status).toBe(502)
  })
})

describe('GET /pwhl/player/career', () => {
  // Shape matches a real live view=player pull (Session 74 investigation,
  // player_id=31 -- Marie-Philip Poulin): careerStats[0].sections[], each
  // section a { title, data: [{ row }] } list ending in a server-computed
  // "Total" row. Rate fields (shooting_percentage etc.) come back as
  // stringified numbers from HockeyTech, same as every other statviewfeed
  // view in this codebase.
  function skaterPayload({ withPlayoffs = true } = {}) {
    const sections = [
      {
        title: 'Regular Season',
        data: [
          { row: { season_name: '2025-26 Regular Season', team_name: 'Montréal Victoire', games_played: '19', goals: '9', assists: '9', points: '18', shots: '58', shooting_percentage: '15.5' } },
          { row: { season_name: 'Total', games_played: 70, goals: 38, assists: 29, points: 67, plus_minus: 30, penalty_minutes: 55, power_play_goals: 7, shots: 225, shooting_percentage: '16.9', short_handed_goals: 1, game_winning_goals: 10 } },
        ],
      },
    ]
    if (withPlayoffs) {
      sections.push({
        title: 'Playoffs',
        data: [
          { row: { season_name: '2026 Playoffs', team_name: 'Montréal Victoire', games_played: '9', goals: '2' } },
          { row: { season_name: 'Total', games_played: 16, goals: 4, assists: 8, points: 12, shots: 73, shooting_percentage: '5.5' } },
        ],
      })
    }
    return { info: { position: 'F' }, careerStats: [{ sections }] }
  }

  it('400s when id is missing', async () => {
    const res = await handlePWHL(
      makeRequest('/pwhl/player/career'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/career')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache without hitting HockeyTech', async () => {
    const cached = { player_id: 31, regularSeason: { goals: 38 }, playoffs: { goals: 4 } }
    const env = makeEnv({ CACHE: makeFakeCache({ 'pwhl:player:career:31': cached }) })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/career?id=31'), env, makeCtx(), new URL('https://example.com/pwhl/player/career?id=31')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('normalizes a live payload, coercing stringified rate stats to numbers and dropping season_name/team_name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(skaterPayload()) })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/career?id=31'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/career?id=31')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.player_id).toBe(31)
    expect(body.regularSeason).toEqual({
      games_played: 70, goals: 38, assists: 29, points: 67, plus_minus: 30,
      penalty_minutes: 55, power_play_goals: 7, shots: 225, shooting_percentage: 16.9,
      short_handed_goals: 1, game_winning_goals: 10,
    })
    expect(body.playoffs).toEqual({ games_played: 16, goals: 4, assists: 8, points: 12, shots: 73, shooting_percentage: 5.5 })
    // per-season rows (only the "Total" row) and season_name/team_name must not leak through
    expect(body.regularSeason.season_name).toBeUndefined()
    expect(body.regularSeason.team_name).toBeUndefined()
  })

  it('returns playoffs: null when the player has no Playoffs section yet', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(skaterPayload({ withPlayoffs: false })) })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/career?id=31'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/career?id=31')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regularSeason.goals).toBe(38)
    expect(body.playoffs).toBeNull()
  })

  it('502s when the HockeyTech fetch fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/career?id=31'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/career?id=31')
    )

    expect(res.status).toBe(502)
  })

  it('502s when the HockeyTech response fails to parse', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'not json' })

    const res = await handlePWHL(
      makeRequest('/pwhl/player/career?id=31'), makeEnv(), makeCtx(), new URL('https://example.com/pwhl/player/career?id=31')
    )

    expect(res.status).toBe(502)
  })
})
