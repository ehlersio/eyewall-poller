// src/__tests__/ahl-routes.test.js
// Route-level tests for handleAHL's routes. Mirrors pwhl-routes.test.js's
// harness/mocking approach (mock at the fetch/KV boundary, not a real
// Workers runtime) and the same set of behaviors tested for
// /pwhl/standings (cache hit, enrichment, 502-on-failure, graceful
// degradation), adapted to AHL's real shape (see ahl.js's module
// docstring for the confirmed differences from PWHL this reflects).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest, mockFetchWithAI, aiPrompt } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 90, seasonType: 'regular' }),
  getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 86: 'regular', 88: 'playoffs', 90: 'regular', 92: 'playoffs', 93: 'preseason', 94: 'regular' }),
  // Real shape and dates (HockeyTech's AHL season list, 2026-09-29).
  getAllAHLSeasons: vi.fn().mockResolvedValue([
    { seasonId: 94, seasonName: '2026-27 Regular Season', seasonType: 'regular', startYear: 2026, startDate: '2026-10-02', endDate: '2027-04-11' },
    { seasonId: 93, seasonName: '2026 Preseason', seasonType: 'preseason', startYear: 2026, startDate: '2026-09-21', endDate: '2026-09-30' },
    { seasonId: 92, seasonName: '2026 Calder Cup Playoffs', seasonType: 'playoffs', startYear: 2026, startDate: '2026-04-20', endDate: '2026-06-20' },
    { seasonId: 90, seasonName: '2025-26 Regular Season', seasonType: 'regular', startYear: 2025, startDate: '2025-10-07', endDate: '2026-04-19' },
    { seasonId: 88, seasonName: '2025 Calder Cup Playoffs', seasonType: 'playoffs', startYear: 2025, startDate: '2025-04-21', endDate: '2025-06-24' },
    { seasonId: 86, seasonName: '2024-25 Regular Season', seasonType: 'regular', startYear: 2024, startDate: '2024-10-09', endDate: '2025-04-20' },
  ]),
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

// The scoreboard's day is whatever day actually has games: today when
// there are any, else the next day that does. Out of season the old
// "today only" query left the tab permanently empty.
describe('GET /ahl/today', () => {
  const rows = (...r) => vi.fn((url) => String(url).includes('ahl_game_log')
    ? Promise.resolve({ ok: true, json: async () => r })
    : Promise.resolve({ ok: true, json: async () => [] }))
  const today = (env = makeEnv()) => handleAHL(
    makeRequest('/ahl/today?season=90'), env, makeCtx(), new URL('https://example.com/ahl/today?season=90')
  )

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-15T23:30:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it("asks for everything from today onward and keeps only the first day's games", async () => {
    globalThis.fetch = rows(
      { game_id: 1, game_date: '2026-01-18', home_team_id: 313, away_team_id: 384, home_score: null, away_score: null, game_state: '7:00 pm EST' },
      { game_id: 2, game_date: '2026-01-18', home_team_id: 402, away_team_id: 373, home_score: null, away_score: null, game_state: '8:00 pm EST' },
      { game_id: 3, game_date: '2026-01-19', home_team_id: 313, away_team_id: 402, home_score: null, away_score: null, game_state: '5:00 pm EST' },
    )

    const body = await (await today()).json()

    expect(globalThis.fetch.mock.calls[0][0]).toContain('game_date=gte.2026-01-15')
    expect(body.map(g => g.gameId)).toEqual([1, 2])          // 2026-01-19 is a different day
    expect(body.every(g => g.gameDate === '2026-01-18')).toBe(true)
    expect(body[0]).toMatchObject({ status: 'pre', statusDetail: '7:00 pm EST' })
  })

  it("passes through HockeyTech's status text for a game under way", async () => {
    globalThis.fetch = rows(
      { game_id: 5, game_date: '2026-01-15', home_team_id: 313, away_team_id: 384, home_score: 2, away_score: 1, game_state: 'In Progress', game_status_code: 2 },
    )
    const body = await (await today()).json()
    expect(body[0]).toMatchObject({ status: 'live', statusDetail: 'In Progress', homeScore: 2, awayScore: 1 })
  })

  it('returns an empty list when the season has no games left at all', async () => {
    globalThis.fetch = rows()
    expect(await (await today()).json()).toEqual([])
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

describe('GET /ahl/prediction -- Elo win probability', () => {
  // game 1028992: TOR (335) hosts ROC (323). team_seasons stats are identical
  // for both teams -- the point split this replaced gave the home side 0%
  // whenever stats tied, e.g. every season opener.
  const tied = { gp: 10, goals_for: 30, goals_against: 30, pp_pct: 0.2, pk_pct: 0.8, points: 10, wins: 5, losses: 5, ot_losses: 0 }
  function handler(eloRows) {
    return (url) => {
      const u = String(url)
      if (u.includes('ahl_game_log?game_id=')) {
        return Promise.resolve({ ok: true, json: async () => [{ game_id: 1028992, season_id: 90, home_team_id: 335, away_team_id: 323 }] })
      }
      if (u.includes('ahl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 335, ...tied }, { team_id: 323, ...tied }] })
      }
      if (u.includes('ahl_team_elo_ratings')) {
        return eloRows instanceof Error ? Promise.reject(eloRows) : Promise.resolve({ ok: true, json: async () => eloRows })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    }
  }
  async function predict(eloRows) {
    const env = makeEnv()
    mockFetchWithAI('Analysis.', handler(eloRows))
    const res = await handleAHL(
      makeRequest('/ahl/prediction?gameId=1028992'), env, makeCtx(),
      new URL('https://example.com/ahl/prediction?gameId=1028992')
    )
    expect(res.status).toBe(200)
    return res.json()
  }

  it('uses both teams\' Elo ratings plus home advantage', async () => {
    const body = await predict([{ team_id: 335, rating: 1560 }, { team_id: 323, rating: 1480 }])
    // 1 / (1 + 10^((1480 - 1560 - 35) / 400)) = 0.659
    expect(body.homeWinPct).toBe(66)
    expect(body.awayWinPct).toBe(34)
    expect(body.winModel).toBe('elo')
  })

  it('an opener with tied stats and equal ratings is a plain home-ice edge, not 0%', async () => {
    const body = await predict([{ team_id: 335, rating: 1500 }, { team_id: 323, rating: 1500 }])
    expect(body.homeWinPct).toBe(55)
  })

  it('falls back to the mean for both teams if the ratings table is unreachable', async () => {
    const body = await predict(new Error('ahl_team_elo_ratings unavailable'))
    expect(body.homeWinPct).toBe(55)
  })

  it('rates a team with no Elo row (new franchise) at the mean', async () => {
    const body = await predict([{ team_id: 323, rating: 1580 }])
    // 1 / (1 + 10^((1580 - 1500 - 35) / 400)) = 0.436
    expect(body.homeWinPct).toBe(44)
  })
})

describe('GET /ahl/prediction -- no made-up stats', () => {
  // ahl_team_seasons rows by season_id (the route reads this season's and
  // last regular season's, every team).
  function mockFlow(game, rowsBySeason) {
    mockFetchWithAI('Analysis.', (url) => {
      const u = String(url)
      if (u.includes('ahl_game_log?game_id=')) return Promise.resolve({ ok: true, json: async () => [game] })
      if (u.includes('ahl_team_seasons')) {
        const season = Number(u.match(/season_id=eq\.(\d+)/)[1])
        return Promise.resolve({ ok: true, json: async () => rowsBySeason[season] || [] })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })
  }
  async function predict() {
    const res = await handleAHL(
      makeRequest('/ahl/prediction?gameId=1028992'), makeEnv(), makeCtx(),
      new URL('https://example.com/ahl/prediction?gameId=1028992')
    )
    return { status: res.status, body: await res.json(), prompt: res.status === 200 ? aiPrompt(globalThis.fetch)[0].content : null }
  }

  const OPENER = { game_id: 1028992, season_id: 94, home_team_id: 335, away_team_id: 323 }
  // 2025-26 finals; pp_pct/pk_pct are 0-1 fractions in ahl_team_seasons.
  const TOR = { team_id: 335, gp: 72, wins: 40, losses: 24, ot_losses: 5, shootout_losses: 3, points: 88, goals_for: 230, goals_against: 200, pp_pct: 0.21, pk_pct: 0.83, pp_opportunities: 280, times_shorthanded: 290 }
  const ROC = { team_id: 323, gp: 72, wins: 35, losses: 28, ot_losses: 6, shootout_losses: 3, points: 79, goals_for: 210, goals_against: 215, pp_pct: 0.17, pk_pct: 0.8, pp_opportunities: 270, times_shorthanded: 260 }
  const others = n => Array.from({ length: n }, (_, i) => ({ team_id: 1000 + i, gp: 72, pp_pct: 0.18, pk_pct: 0.82, pp_opportunities: 250, times_shorthanded: 250 }))
  const zeroGp = team_id => ({ team_id, gp: 0, wins: 0, losses: 0, ot_losses: 0, shootout_losses: 0, points: 0, goals_for: 0, goals_against: 0, pp_pct: 0, pk_pct: 0, pp_opportunities: 0, times_shorthanded: 0 })

  it('0 GP for both teams: last regular season (90 -- not the 93 preseason or 92 playoffs), no 0.0%', async () => {
    mockFlow(OPENER, { 94: [zeroGp(335), zeroGp(323)], 90: [TOR, ROC, ...others(22)] })
    const { status, body, prompt } = await predict()
    expect(status).toBe(200)
    expect(prompt).toContain('You are EyeWall Analytics, an AHL hockey analytics assistant. Write a sharp, data-driven PRESEASON analysis')
    expect(prompt).toContain('TOR, 2025-26 regular season: 40-24-5-3 (88 pts, 72 GP), GF/GA per game: 3.19 / 2.78, PP%: 21.0%, PK%: 83.0%')
    expect(prompt).toContain('ROC, 2025-26 regular season: 35-28-6-3 (79 pts, 72 GP), GF/GA per game: 2.92 / 2.99, PP%: 17.0%, PK%: 80.0%')
    // Mean of 24 real values -- 3/4 of the league.
    expect(prompt).toContain('League average (2025-26 regular season, mean of 24 teams): PP% 18.1% · PK% 82.0%')
    expect(prompt).toContain('do not reference Corsi')
    expect(prompt).not.toMatch(/[^\d.]0\.0%/)
    expect(body.expHome).not.toBeNull()
    expect(body.corsiForPct).toBeUndefined()
  })

  it('omits the league average when fewer than 24 teams have the stat', async () => {
    mockFlow(OPENER, { 94: [zeroGp(335), zeroGp(323)], 90: [TOR, ROC, ...others(21)] })
    expect((await predict()).prompt).not.toContain('League average')
  })

  it('blends a few games with last regular season and labels the estimate', async () => {
    const TOR_4GP = { team_id: 335, gp: 4, wins: 3, losses: 1, ot_losses: 0, shootout_losses: 0, points: 6, goals_for: 16, goals_against: 8, pp_pct: 0.25, pk_pct: 0.9, pp_opportunities: 12, times_shorthanded: 10 }
    mockFlow(OPENER, { 94: [TOR_4GP, zeroGp(323)], 90: [TOR, ROC] })
    const { prompt } = await predict()
    expect(prompt).toContain('TOR stats:\n- Record: 3-1-0-0 (6 pts, 4 GP)')
    // (4 * 4.00 + 20 * 3.19) / 24 = 3.33; (4 * 25.0 + 30 * 21.0) / 34 = 21.5
    expect(prompt).toContain('- GF per game: 3.33 early-season estimate (4.00 in 4 GP this season, blended with 3.19 in 2025-26 regular season)')
    expect(prompt).toContain('- PP%: 21.5% early-season estimate (25.0% in 4 GP this season, blended with 21.0% in 2025-26 regular season)')
    expect(prompt).toContain('ROC stats:\n- Record: 0-0-0-0 (0 pts, 0 GP)\n- GF per game: 2.92 (2025-26 regular season; none this season yet)')
    expect(prompt).not.toMatch(/P[PK]%: 0\.0%/)
  })

  it('a stat missing from the row is "not available" and there is no expected score from zeros', async () => {
    const TOR_NO_GOALS = { ...TOR, goals_for: null, pp_pct: null }
    mockFlow({ ...OPENER, season_id: 90 }, { 90: [TOR_NO_GOALS, ROC] })
    const { body, prompt } = await predict()
    expect(prompt).toContain('- GF per game: not available')
    expect(prompt).toContain('- PP%: not available')
    expect(prompt).not.toContain('Expected score')
    expect(body.expHome).toBeNull()
    expect(body.expAway).toBeNull()
  })
})
