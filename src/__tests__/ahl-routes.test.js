// src/__tests__/ahl-routes.test.js
// Route-level tests for handleAHL's routes. Mirrors pwhl-routes.test.js's
// harness/mocking approach (mock at the fetch/KV boundary, not a real
// Workers runtime) and the same set of behaviors tested for
// /pwhl/standings (cache hit, enrichment, 502-on-failure, graceful
// degradation), adapted to AHL's real shape (see ahl.js's module
// docstring for the confirmed differences from PWHL this reflects).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 90, seasonType: 'regular' }),
  getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 90: 'regular', 92: 'playoffs' }),
}))

import { handleAHL, AHL_TEAM_CODES } from '../ahl.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('AHL_TEAM_CODES', () => {
  it('has 32 current teams plus the BRI historical entry', () => {
    // 32 current team_ids + 1 historical (317: BRI, pre-2026-27-relocation
    // identity of 457: HAM) = 33 total keys.
    expect(Object.keys(AHL_TEAM_CODES)).toHaveLength(33)
    expect(AHL_TEAM_CODES[457]).toBe('HAM')
    expect(AHL_TEAM_CODES[317]).toBe('BRI')
  })
})

describe('GET /ahl/standings', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify([{ team_id: 335 }]) }, async put() {} } })

    const res = await handleAHL(
      makeRequest('/ahl/standings?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/standings?season=90')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 335 }])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('enriches standings with L10/streak from the game log on a cache miss (no OT-loss split, unlike PWHL)', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('ahl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 335, points: 40 }] })
      }
      return Promise.resolve({
        ok: true,
        json: async () => [{ game_id: 1, home_team_id: 335, away_team_id: 323, home_score: 3, away_score: 1 }],
      })
    })

    const res = await handleAHL(
      makeRequest('/ahl/standings?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/standings?season=90')
    )

    const body = await res.json()
    expect(body[0]).toMatchObject({ team_id: 335, l10W: 1, l10L: 0, streakType: 'W', streakCount: 1 })
  })

  it('returns 502 when the standings fetch itself fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const res = await handleAHL(
      makeRequest('/ahl/standings?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/standings?season=90')
    )

    expect(res.status).toBe(502)
  })

  it('degrades gracefully (no L10/streak) if only the game-log fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('ahl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 335, points: 40 }] })
      }
      return Promise.resolve({ ok: false, status: 500 })
    })

    const res = await handleAHL(
      makeRequest('/ahl/standings?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/standings?season=90')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 335, points: 40 }])
  })
})

describe('GET /ahl/schedule', () => {
  it('requires teamId', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/schedule?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/schedule?season=90')
    )
    expect(res.status).toBe(400)
  })

  it('returns the team game log on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ game_id: 1, home_team_id: 335 }] })

    const res = await handleAHL(
      makeRequest('/ahl/schedule?teamId=335&season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/schedule?teamId=335&season=90')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ game_id: 1, home_team_id: 335 }])
  })
})

describe('GET /ahl/roster', () => {
  it('requires teamId', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/roster'), env, makeCtx(),
      new URL('https://example.com/ahl/roster')
    )
    expect(res.status).toBe(400)
  })

  it('returns the bare player list on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ player_id: 1, first_name: 'A' }] })

    const res = await handleAHL(
      makeRequest('/ahl/roster?teamId=335'), env, makeCtx(),
      new URL('https://example.com/ahl/roster?teamId=335')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ player_id: 1, first_name: 'A' }])
  })
})

describe('GET /ahl/players', () => {
  it('requires teamId', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/players?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/players?season=90')
    )
    expect(res.status).toBe(400)
  })

  it('joins skater/goalie season stats with player bio names on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('ahl_player_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ player_id: 1, points: 10 }] })
      }
      if (String(url).includes('ahl_goalie_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [] })
      }
      // Both ahl_players calls (team roster + all-players name map)
      return Promise.resolve({ ok: true, json: async () => [{ player_id: 1, first_name: 'Vinni', last_name: 'Lettieri', jersey_number: 91 }] })
    })

    const res = await handleAHL(
      makeRequest('/ahl/players?teamId=335&season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/players?teamId=335&season=90')
    )

    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skaters[0]).toMatchObject({ player_id: 1, points: 10, player_name: 'Vinni Lettieri' })
    expect(body.roster[0]).toMatchObject({ player_id: 1, jersey_number: 91 })
  })
})

describe('GET /ahl/league-players', () => {
  it('returns skaters and goalies enriched with names', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('ahl_player_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ player_id: 1, points: 10, team_id: 335 }] })
      }
      if (String(url).includes('ahl_goalie_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ player_id: 2, sv_pct: 0.9, team_id: 335 }] })
      }
      return Promise.resolve({ ok: true, json: async () => [{ player_id: 1, first_name: 'A', last_name: 'B' }] })
    })

    const res = await handleAHL(
      makeRequest('/ahl/league-players?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/league-players?season=90')
    )

    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skaters[0].player_name).toBe('A B')
    expect(body.goalies[0]).toMatchObject({ player_id: 2, sv_pct: 0.9 })
  })
})

describe('GET /ahl/shots', () => {
  it('requires teamId', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/shots?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/shots?season=90')
    )
    expect(res.status).toBe(400)
  })

  it('paginates through Supabase in batches of 1000', async () => {
    const env = makeEnv()
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: i, event_type: 'shot' }))
    const page2 = [{ id: 1000, event_type: 'goal' }]
    let call = 0
    globalThis.fetch = vi.fn(() => {
      call++
      return Promise.resolve({ ok: true, json: async () => (call === 1 ? page1 : page2) })
    })

    const res = await handleAHL(
      makeRequest('/ahl/shots?teamId=335&season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/shots?teamId=335&season=90')
    )

    const body = await res.json()
    expect(body).toHaveLength(1001)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('GET /ahl/team-season-summary', () => {
  it('requires teamId', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/team-season-summary?season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/team-season-summary?season=90')
    )
    expect(res.status).toBe(400)
  })

  it('has no hits/faceoff/penalties sections, unlike /pwhl/team-season-summary', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('ahl_game_log')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 1 }] })
      }
      if (String(url).includes('ahl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ pp_pct: 0.2, pk_pct: 0.8 }] })
      }
      return Promise.resolve({ ok: true, json: async () => [{ team_id: 335, event_type: 'shot' }, { team_id: 323, event_type: 'goal' }] })
    })

    const res = await handleAHL(
      makeRequest('/ahl/team-season-summary?teamId=335&season=90'), env, makeCtx(),
      new URL('https://example.com/ahl/team-season-summary?teamId=335&season=90')
    )

    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ teamId: 335, season: 90, gamesPlayed: 1, sog: { car: 1, opp: 1 }, ppPct: 0.2, pkPct: 0.8 })
    expect(body.hits).toBeUndefined()
    expect(body.faceoff).toBeUndefined()
    expect(body.penalties).toBeUndefined()
  })
})

describe('unknown /ahl/* route', () => {
  it('returns 404', async () => {
    const env = makeEnv()
    const res = await handleAHL(
      makeRequest('/ahl/nonexistent'), env, makeCtx(),
      new URL('https://example.com/ahl/nonexistent')
    )
    expect(res.status).toBe(404)
  })
})
