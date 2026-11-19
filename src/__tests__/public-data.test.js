// GET /config/teams, /win-probs and /playoff-odds/league (publicData.js),
// the league-wide reads eyewall-api serves from, through worker.js's
// handleRequest.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest } from '../worker.js'
import { leagueTeams } from '../publicData.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T15:00:00Z'))
})

function mockSupabase(handlers) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = decodeURIComponent(String(url))
    const h = handlers.find(x => u.includes(x.match))
    if (!h) return { ok: true, status: 200, json: async () => [] }
    const status = h.status ?? 200
    return { ok: status < 300, status, json: async () => (typeof h.rows === 'function' ? h.rows(u) : h.rows) }
  })
}
const urls = () => globalThis.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)))
const get = (path, env = makeEnv()) => handleRequest(makeRequest(path), env, makeCtx())

describe('leagueTeams', () => {
  it('NHL: the 32 clubs with NHL ids, sorted by code', () => {
    const teams = leagueTeams('nhl')
    expect(teams).toHaveLength(32)
    expect(teams.find(t => t.code === 'CAR')).toEqual({ id: 12, code: 'CAR', name: 'Carolina Hurricanes' })
    expect(teams.map(t => t.code)).toEqual([...teams.map(t => t.code)].sort())
    expect(teams.some(t => t.code === 'ARI')).toBe(false)
  })

  it('AHL/ECHL leave out historical ids; every current team has a name', () => {
    const ahl = leagueTeams('ahl')
    expect(ahl.some(t => t.id === 317)).toBe(false)
    expect(ahl.find(t => t.id === 457)).toEqual({ id: 457, code: 'HAM', name: 'Hamilton Hammers' })
    const echl = leagueTeams('echl')
    expect(echl.some(t => t.id === 98 || t.id === 23)).toBe(false)
    for (const t of [...ahl, ...echl, ...leagueTeams('pwhl')]) expect(t.name).toBeTruthy()
  })

  it('PWHL includes the 2026-27 expansion teams', () => {
    const codes = leagueTeams('pwhl').map(t => t.code)
    expect(codes).toEqual(expect.arrayContaining(['DET', 'HAM', 'LV', 'SJS', 'BOS']))
  })

  it('unknown league is null', () => {
    expect(leagueTeams('khl')).toBeNull()
  })
})

describe('GET /config/teams', () => {
  it('answers the league and its teams, cached for an hour', async () => {
    const res = await get('/config/teams?league=pwhl')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600')
    const body = await res.json()
    expect(body.league).toBe('pwhl')
    expect(body.teams).toEqual(leagueTeams('pwhl'))
  })

  it('400 for a missing or unknown league', async () => {
    expect((await get('/config/teams')).status).toBe(400)
    expect((await get('/config/teams?league=khl')).status).toBe(400)
  })
})

describe('GET /win-probs', () => {
  const nhlRow = {
    game_id: 2026020331, game_date: '2026-11-16', game_type: 2, season: 20262027,
    home_team: 'NYR', away_team: 'MTL', neutral: false,
    home_rating: 1497.1, away_rating: 1532.0, home_win_prob: 0.4517, run_date: '2026-11-16',
  }

  it('NHL by date reads game_win_probs and caches the rows', async () => {
    const env = makeEnv()
    mockSupabase([{ match: 'game_win_probs?', rows: [nhlRow] }])
    const res = await get('/win-probs?league=nhl&date=2026-11-16', env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ league: 'nhl', games: [nhlRow] })
    expect(urls()[0]).toContain('/rest/v1/game_win_probs?')
    expect(urls()[0]).toContain('game_date=eq.2026-11-16')
    expect(env.CACHE._store.has('public:win-probs:nhl:2026-11-16')).toBe(true)
  })

  it('HockeyTech by gameId reads {league}_game_win_probs', async () => {
    mockSupabase([{ match: 'ahl_game_win_probs?', rows: [{ game_id: 1029331, home_win_prob: 0.59 }] }])
    const res = await get('/win-probs?league=ahl&gameId=1029331')
    expect((await res.json()).games).toHaveLength(1)
    expect(urls()[0]).toContain('/rest/v1/ahl_game_win_probs?')
    expect(urls()[0]).toContain('game_id=eq.1029331')
  })

  it('an empty day is not cached', async () => {
    const env = makeEnv()
    mockSupabase([])
    const res = await get('/win-probs?league=echl&date=2026-11-18', env)
    expect(await res.json()).toEqual({ league: 'echl', games: [] })
    expect(env.CACHE._store.size).toBe(0)
  })

  it('a failed read answers unavailable, uncached', async () => {
    const env = makeEnv()
    mockSupabase([{ match: 'game_win_probs', status: 503, rows: [] }])
    const res = await get('/win-probs?league=nhl&date=2026-11-16', env)
    expect(await res.json()).toEqual({ league: 'nhl', games: [], unavailable: true })
    expect(env.CACHE._store.size).toBe(0)
  })

  it('400 without date or gameId, or with a bad date', async () => {
    expect((await get('/win-probs?league=nhl')).status).toBe(400)
    expect((await get('/win-probs?league=nhl&date=11/16/2026')).status).toBe(400)
    expect((await get('/win-probs?league=nhl&gameId=abc')).status).toBe(400)
  })
})

describe('GET /playoff-odds/league', () => {
  it('NHL: every team from the latest run, highest odds first', async () => {
    const env = makeEnv()
    const car = { team: 'CAR', season: 20262027, run_date: '2026-11-16', playoff_pct: 0.98 }
    const njd = { team: 'NJD', season: 20262027, run_date: '2026-11-16', playoff_pct: 0.79 }
    mockSupabase([
      { match: 'playoff_odds?select=season,run_date', rows: [{ season: 20262027, run_date: '2026-11-16' }] },
      { match: 'playoff_odds?select=team,', rows: [car, njd] },
    ])
    const res = await get('/playoff-odds/league?league=nhl', env)
    expect(await res.json()).toEqual({
      league: 'nhl', season: 20262027, runDate: '2026-11-16', stale: false, teams: [car, njd],
    })
    expect(urls()[1]).toContain('season=eq.20262027&run_date=eq.2026-11-16')
    expect(env.CACHE._store.has('public:playoff-odds:nhl:latest')).toBe(true)
  })

  it('HockeyTech: reads {league}_playoff_odds by season_id', async () => {
    mockSupabase([
      { match: 'pwhl_playoff_odds?select=season_id,run_date', rows: [{ season_id: 11, run_date: '2026-11-16' }] },
      { match: 'pwhl_playoff_odds?select=season_id,team_id', rows: [{ season_id: 11, team_id: 1, games_played: 0 }] },
    ])
    const body = await (await get('/playoff-odds/league?league=pwhl&season=11')).json()
    expect(body).toMatchObject({ league: 'pwhl', season: 11, runDate: '2026-11-16', teams: [{ team_id: 1 }] })
    expect(urls()[0]).toContain('season_id=eq.11')
  })

  it('HockeyTech without the games_played column retries without it', async () => {
    mockSupabase([
      { match: 'ahl_playoff_odds?select=season_id,run_date', rows: [{ season_id: 94, run_date: '2026-11-16' }] },
      { match: ',games_played&', status: 400, rows: [] },
      { match: 'ahl_playoff_odds?select=season_id,team_id', rows: [{ season_id: 94, team_id: 373 }] },
    ])
    const body = await (await get('/playoff-odds/league?league=ahl')).json()
    expect(body.teams).toEqual([{ season_id: 94, team_id: 373, games_played: null }])
  })

  it('no runs yet: the empty shape, not cached', async () => {
    const env = makeEnv()
    mockSupabase([])
    const body = await (await get('/playoff-odds/league?league=echl', env)).json()
    expect(body).toEqual({ league: 'echl', season: null, runDate: null, stale: false, teams: [] })
    expect(env.CACHE._store.size).toBe(0)
  })

  it('a stale run is flagged', async () => {
    mockSupabase([
      { match: 'playoff_odds?select=season,run_date', rows: [{ season: 20262027, run_date: '2026-11-10' }] },
      { match: 'playoff_odds?select=team,', rows: [{ team: 'CAR' }] },
    ])
    expect((await (await get('/playoff-odds/league?league=nhl')).json()).stale).toBe(true)
  })
})

describe('GET /nhl/power-rankings/league', () => {
  it('every team from the latest run, best first', async () => {
    const env = makeEnv()
    mockSupabase([
      { match: 'power_rankings_narratives?select=season,generated_date', rows: [{ season: 20262027, generated_date: '2026-11-16' }] },
      { match: 'power_rankings_narratives?select=team,rank,prior_rank', rows: [
        { team: 'CAR', rank: 1, prior_rank: 1 }, { team: 'COL', rank: 2, prior_rank: 3 },
      ] },
    ])
    const res = await get('/nhl/power-rankings/league', env)
    expect(await res.json()).toEqual({
      season: 20262027, runDate: '2026-11-16',
      teams: [{ team: 'CAR', rank: 1, prior_rank: 1 }, { team: 'COL', rank: 2, prior_rank: 3 }],
    })
    expect(urls()[1]).toContain('season=eq.20262027&generated_date=eq.2026-11-16')
    expect(env.CACHE._store.has('public:nhl-power-rankings:latest')).toBe(true)
  })

  it('a season filter, and no run: empty, uncached', async () => {
    const env = makeEnv()
    mockSupabase([])
    const body = await (await get('/nhl/power-rankings/league?season=20212022', env)).json()
    expect(body).toEqual({ season: 20212022, runDate: null, teams: [] })
    expect(urls()[0]).toContain('season=eq.20212022')
    expect(env.CACHE._store.size).toBe(0)
  })

  it('a failed read answers unavailable', async () => {
    mockSupabase([{ match: 'power_rankings_narratives', status: 500, rows: [] }])
    expect((await (await get('/nhl/power-rankings/league')).json()).unavailable).toBe(true)
  })
})

describe('GET /game-shot-xg', () => {
  const nhlRow = (gameId, team, situation = 'all') => ({
    game_id: gameId, season: 20262027, game_type: 2, game_date: '2026-11-18', team,
    opponent: team === 'NJD' ? 'MTL' : 'NJD', is_home: team === 'MTL', situation,
    attempts: 48, goals: 2, xg: 3.888, model: 'logistic-2026-11-18', updated_at: '2026-11-19T09:00:00Z',
  })

  it('NHL by date reads game_shot_xg (never game_xg) and caches', async () => {
    const env = makeEnv()
    mockSupabase([{ match: 'game_shot_xg?', rows: [nhlRow(2026020345, 'MTL'), nhlRow(2026020345, 'NJD')] }])
    const res = await get('/game-shot-xg?league=nhl&date=2026-11-18', env)
    const body = await res.json()
    expect(body.rows).toHaveLength(2)
    expect(body.season).toBe(20262027)
    expect(urls()[0]).toContain('/rest/v1/game_shot_xg?')
    expect(urls()[0]).toContain('game_date=eq.2026-11-18')
    expect(urls().some(u => u.includes('/rest/v1/game_xg?'))).toBe(false)
    expect(env.CACHE._store.has('public:game-shot-xg:nhl:2026-11-18')).toBe(true)
  })

  it('HockeyTech by gameId reads {league}_game_shot_xg', async () => {
    mockSupabase([{ match: 'pwhl_game_shot_xg?', rows: [{ game_id: 210, season_id: 8, team_id: 1 }] }])
    const res = await get('/game-shot-xg?league=pwhl&gameId=210')
    expect((await res.json()).rows).toHaveLength(1)
    expect(urls()[0]).toContain('/rest/v1/pwhl_game_shot_xg?')
    expect(urls()[0]).toContain('game_id=eq.210')
  })

  it('a season pages past 1,000 rows in a fixed order', async () => {
    const page = n => Array.from({ length: n }, (_, i) => nhlRow(2026020000 + i, 'CAR'))
    mockSupabase([{ match: 'game_shot_xg?', rows: u => (u.includes('offset=0') ? page(1000) : page(7)) }])
    const body = await (await get('/game-shot-xg?league=nhl&season=20262027')).json()
    expect(body.rows).toHaveLength(1007)
    expect(urls()).toHaveLength(2)
    expect(urls()[0]).toContain('order=game_id.asc,team.asc,situation.asc')
    expect(urls()[1]).toContain('offset=1000')
  })

  it('season=latest resolves the newest season in the table', async () => {
    mockSupabase([
      { match: 'select=season_id&order=season_id.desc', rows: [{ season_id: 94 }] },
      { match: 'ahl_game_shot_xg?select=game_id', rows: [{ game_id: 1, season_id: 94, team_id: 5 }] },
    ])
    const body = await (await get('/game-shot-xg?league=ahl&season=latest')).json()
    expect(body.season).toBe(94)
    expect(urls()[1]).toContain('season_id=eq.94')
  })

  it('empty answers are not cached; failures say unavailable', async () => {
    const env = makeEnv()
    mockSupabase([])
    expect(await (await get('/game-shot-xg?league=echl&date=2026-11-18', env)).json())
      .toEqual({ league: 'echl', season: null, rows: [] })
    mockSupabase([{ match: 'game_shot_xg', status: 503, rows: [] }])
    expect((await (await get('/game-shot-xg?league=nhl&date=2026-11-17', env)).json()).unavailable).toBe(true)
    expect(env.CACHE._store.size).toBe(0)
  })

  it('400 without a selector or with bad values', async () => {
    expect((await get('/game-shot-xg?league=nhl')).status).toBe(400)
    expect((await get('/game-shot-xg?league=nhl&date=yesterday')).status).toBe(400)
    expect((await get('/game-shot-xg?league=nhl&season=2026-27')).status).toBe(400)
    expect((await get('/game-shot-xg?league=khl&date=2026-11-18')).status).toBe(400)
  })
})
