// src/__tests__/hockeytech-traded-and-today.test.js
// Two AHL/ECHL Worker changes (2026-10), against real data:
//   - league-wide routes combine a traded player's season rows, whether the
//     pipeline stores one league-wide row (today) or one row per team
//     (eyewall-pipeline#190, audit #14);
//   - /{league}/today reads the seasons after ?season= and, when game_log
//     doesn't have the next game day yet, HockeyTech's scorebar;
//   - /{league}/live/:id and the push poll fall back to that scorebar for
//     a game game_log doesn't have at all (audit 2026-10-06, AHL/ECHL F4).
//
// Traded players, AHL 2025-26 regular season (season 90), per-team splits
// from HockeyTech's view=player / team-scoped view=players on 2026-10-05:
//   Graeme Clarke (8598, RW, now BEL 413): HER 50 GP 15-9-24, BEL 15 GP
//     5-14-19 -- ahl_player_seasons' league-wide row is 65 GP 20-23-43.
//   Laurent Brossoit (4961, G, now SD 404): RFD (372) 6 GP, SJ (405) 28 GP.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import { scorebar as echlScorebar } from './fixtures/echl-scorebar-2026-10.js'
import { combineSeasonRows, combineByPlayer } from '../hockeytechSeasonRows.js'

const sendPushMock = vi.hoisted(() => vi.fn())
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock }
})

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 94, seasonType: 'regular' }),
    getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 90: 'regular', 94: 'regular' }),
    getAllAHLSeasons: vi.fn().mockResolvedValue([
      { seasonId: 90, seasonType: 'regular', startYear: 2025, startDate: '2025-10-07' },
      { seasonId: 94, seasonType: 'regular', startYear: 2026, startDate: '2026-10-02' },
    ]),
    resolveECHLSeason: vi.fn().mockResolvedValue({ seasonId: 76, seasonType: 'playoffs' }),
    getAllECHLSeasonTypes: vi.fn().mockResolvedValue({ 73: 'regular', 75: 'allstar', 76: 'playoffs', 77: 'preseason', 78: 'regular' }),
    // Real ECHL season list (feed=modulekit&view=seasons, 2026-10-05).
    getAllECHLSeasons: vi.fn().mockResolvedValue([
      { seasonId: 78, seasonType: 'regular',   startYear: 2026, startDate: '2026-10-15', endDate: '2027-04-11' },
      { seasonId: 77, seasonType: 'preseason', startYear: 2026, startDate: '2026-06-23', endDate: '2026-10-14' },
      { seasonId: 76, seasonType: 'playoffs',  startYear: 2026, startDate: '2026-04-21', endDate: '2026-06-17' },
      { seasonId: 75, seasonType: 'allstar',   startYear: 2026, startDate: '2026-01-19', endDate: '2026-01-20' },
      { seasonId: 73, seasonType: 'regular',   startYear: 2025, startDate: '2025-10-15', endDate: '2026-04-19' },
    ]),
  }
})

import { handleAHL } from '../ahl.js'
import { handleECHL, pollECHL } from '../echl.js'

const base = { season_id: 90, season_type: 'regular' }
const clarkeHER = { ...base, player_id: 8598, team_id: 319, gp: 50, goals: 15, assists: 9,  points: 24, plus_minus: -8, pim: 24, shots: 126, pp_goals: 4, sh_goals: 0 }
const clarkeBEL = { ...base, player_id: 8598, team_id: 413, gp: 15, goals: 5,  assists: 14, points: 19, plus_minus: 3,  pim: 18, shots: 46,  pp_goals: 3, sh_goals: 0 }
// ahl_player_seasons today (one league-wide row).
const clarkeLeague = { ...base, player_id: 8598, team_id: 413, gp: 65, goals: 20, assists: 23, points: 43, plus_minus: -5, pim: 42, shots: 172, pp_goals: 7, sh_goals: 0 }
const brossoitRFD = { ...base, player_id: 4961, team_id: 372, gp: 6,  wins: 3,  losses: 3,  ot_losses: 0, shutouts: 0, saves: 182, shots_against: 202, goals_against: 20, sv_pct: 0.901, gaa: 3.38, toi: '355:09' }
const brossoitSJ  = { ...base, player_id: 4961, team_id: 405, gp: 28, wins: 15, losses: 11, ot_losses: 1, shutouts: 0, saves: 764, shots_against: 848, goals_against: 84, sv_pct: 0.901, gaa: 3.06, toi: '1648:49' }
// A teammate who wasn't traded (real league-wide row, SJ 2025-26).
const other = { ...base, player_id: 10086, team_id: 405, gp: 65, goals: 22, assists: 38, points: 60, plus_minus: -2, pim: 22, shots: 119, pp_goals: 6, sh_goals: 1 }
const players = [
  { player_id: 8598,  first_name: 'Graeme',  last_name: 'Clarke',   position: 'RW', team_id: 413 },
  { player_id: 4961,  first_name: 'Laurent', last_name: 'Brossoit', position: 'G',  team_id: 404 },
  { player_id: 10086, first_name: 'Other',   last_name: 'Skater',   position: 'C',  team_id: 405 },
]

const rows = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })

function installFetch({ tables = {}, scorebar = null, pbp = [] }) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (u.pathname.startsWith('/rest/v1/')) {
      const t = tables[u.pathname.slice('/rest/v1/'.length)]
      return rows(typeof t === 'function' ? t(u.searchParams) : (t ?? []))
    }
    if (u.searchParams.get('view') === 'scorebar') return rows({ SiteKit: { Scorebar: scorebar ?? [] } })
    if (u.searchParams.get('view') === 'gameCenterPlayByPlay') return { ok: true, status: 200, text: async () => `(${JSON.stringify(pbp)})` }
    return rows({})
  })
}

const byId = (params, list) => {
  const f = params.get('player_id')
  return f ? list.filter(r => r.player_id === Number(f.slice(3))) : list
}

async function get(handler, path) {
  const res = await handler(makeRequest(path), makeEnv(), makeCtx(), new URL(`https://example.com${path}`))
  return { status: res.status, body: await res.json() }
}

const urls = () => globalThis.fetch.mock.calls.map(([u]) => String(u))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  sendPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── combining a player's season rows ─────────────────────────────────
describe('combineSeasonRows', () => {
  it('Clarke\'s HER + BEL rows sum to the league-wide row, shown under his current team, with each part kept', () => {
    const c = combineSeasonRows([clarkeHER, clarkeBEL], 'skater', 413)
    for (const f of ['gp', 'goals', 'assists', 'points', 'plus_minus', 'pim', 'shots', 'pp_goals', 'sh_goals']) {
      expect(c[f]).toBe(clarkeLeague[f])
    }
    expect(c.team_id).toBe(413)
    expect(c.teams.map(t => [t.team_id, t.gp, t.points])).toEqual([[319, 50, 24], [413, 15, 19]])
  })

  it('Brossoit\'s RFD + SJ rows: counts summed, SV% and GAA recomputed from the sums', () => {
    const g = combineSeasonRows([brossoitRFD, brossoitSJ], 'goalie', 404)
    expect(g).toMatchObject({ gp: 34, wins: 18, losses: 14, ot_losses: 1, saves: 946, shots_against: 1050, goals_against: 104, toi: '2003:58' })
    expect(g.sv_pct).toBe(0.901)              // 946 / 1050
    expect(g.gaa).toBe(3.11)                  // 104 * 60 / 2003:58
    expect(g.team_id).toBe(405)               // now SD, so the team he played most for
  })

  it('a single row comes back unchanged, and SV%/GAA are null rather than guessed when a part lacks TOI', () => {
    expect(combineSeasonRows([clarkeLeague], 'skater', 413)).toEqual(clarkeLeague)
    const g = combineSeasonRows([brossoitRFD, { ...brossoitSJ, toi: null }], 'goalie', 404)
    expect(g.gaa).toBeNull()
    expect(g.toi).toBeNull()
    expect(g.sv_pct).toBe(0.901)
  })

  it('combineByPlayer: one row per player whatever the shape', () => {
    const out = combineByPlayer([clarkeHER, other, clarkeBEL], 'skater', { 8598: 413 })
    expect(out.map(r => [r.player_id, r.points])).toEqual([[8598, 43], [10086, 60]])
  })
})

// ── /ahl/league-players ──────────────────────────────────────────────
describe('/ahl/league-players with traded players', () => {
  for (const [shape, skaterRows, goalieRows] of [
    ['one row per team (eyewall-pipeline#190)', [clarkeHER, clarkeBEL, other], [brossoitRFD, brossoitSJ]],
    ['one league-wide row (today)', [clarkeLeague, other], [brossoitSJ]],
  ]) {
    it(`lists Clarke once with his full season -- ${shape}`, async () => {
      installFetch({ tables: { ahl_player_seasons: skaterRows, ahl_goalie_seasons: goalieRows, ahl_players: players } })
      const { status, body } = await get(handleAHL, '/ahl/league-players?season=90')
      expect(status).toBe(200)
      const clarke = body.skaters.filter(s => s.player_id === 8598)
      expect(clarke).toHaveLength(1)
      expect(clarke[0]).toMatchObject({ gp: 65, goals: 20, assists: 23, points: 43, team_id: 413, player_name: 'Graeme Clarke' })
      expect(body.skaters.map(s => s.player_id)).toEqual([10086, 8598]) // points desc
      expect(body.goalies.filter(g => g.player_id === 4961)).toHaveLength(1)
    })
  }

  it('pages every row and name past Supabase\'s 1,000-row cap', async () => {
    installFetch({ tables: { ahl_player_seasons: [clarkeLeague], ahl_goalie_seasons: [], ahl_players: players } })
    await get(handleAHL, '/ahl/league-players?season=90')
    const reads = globalThis.fetch.mock.calls.filter(([u]) => /ahl_(player_seasons|goalie_seasons|players)\?/.test(String(u)))
    expect(reads).toHaveLength(3)
    for (const [u, opts] of reads) {
      expect(String(u)).not.toContain('limit=')
      expect(opts.headers.Range).toBe('0-999')
    }
  })
})

// ── /ahl/player/landing ──────────────────────────────────────────────
describe('/ahl/player/landing with traded players', () => {
  it('Clarke 2025-26 from per-team rows: the whole season, with each team\'s part', async () => {
    installFetch({ tables: { ahl_players: (p) => byId(p, players), ahl_player_seasons: [clarkeHER, clarkeBEL] } })
    const { body } = await get(handleAHL, '/ahl/player/landing?id=8598&season=90')
    expect(body).toMatchObject({ first_name: 'Graeme', gp: 65, points: 43, team_id: 413 })
    expect(body.teams.map(t => t.team_id)).toEqual([319, 413])
  })

  it('no ?season=: combines only the latest regular season\'s rows', async () => {
    const older = { ...clarkeLeague, season_id: 86, gp: 70, points: 50 }
    installFetch({ tables: { ahl_players: (p) => byId(p, players), ahl_player_seasons: [clarkeHER, clarkeBEL, older] } })
    const { body } = await get(handleAHL, '/ahl/player/landing?id=8598')
    expect(body).toMatchObject({ season_id: 90, gp: 65, points: 43 })
  })

  it('Brossoit 2025-26 from per-team rows: goalie totals and recomputed SV%/GAA', async () => {
    installFetch({ tables: { ahl_players: (p) => byId(p, players), ahl_goalie_seasons: [brossoitRFD, brossoitSJ] } })
    const { body } = await get(handleAHL, '/ahl/player/landing?id=4961&season=90')
    expect(body).toMatchObject({ last_name: 'Brossoit', gp: 34, sv_pct: 0.901, gaa: 3.11 })
  })

  it('the old single-row shape is served as before (no teams list)', async () => {
    installFetch({ tables: { ahl_players: (p) => byId(p, players), ahl_player_seasons: [clarkeLeague] } })
    const { body } = await get(handleAHL, '/ahl/player/landing?id=8598&season=90')
    expect(body).toMatchObject({ gp: 65, points: 43, team_id: 413 })
    expect(body.teams).toBeUndefined()
  })
})

// ── /echl/today ──────────────────────────────────────────────────────
describe('/echl/today looks ahead into the next season', () => {
  it('2026-10-05 (current season 76, nothing in game_log): the 10-08 preseason games from the scorebar', async () => {
    vi.setSystemTime(new Date('2026-10-05T16:00:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: echlScorebar })
    const { status, body } = await get(handleECHL, '/echl/today?season=76')
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(0)
    expect(new Set(body.map(g => g.gameDate))).toEqual(new Set(['2026-10-08']))
    expect(body.every(g => g.status === 'pre')).toBe(true)
    // game_log was asked for 76 and every later non-All-Star season.
    expect(urls().find(u => u.includes('echl_game_log'))).toContain('season_id=in.(76,77,78)')
  })

  it('opening night 2026-10-17: the season-78 games, before game_log has them', async () => {
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: echlScorebar.filter(g => g.Date === '2026-10-17') })
    const { body } = await get(handleECHL, '/echl/today?season=78')
    expect(body.length).toBe(echlScorebar.filter(g => g.Date === '2026-10-17').length)
    expect(body.every(g => g.gameDate === '2026-10-17')).toBe(true)
    expect(body[0]).toMatchObject({ homeTeamCode: expect.any(String), awayTeamCode: expect.any(String) })
  })

  it('game_log has a game today: served from game_log, no scorebar look-ahead', async () => {
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'))
    const g = echlScorebar.find(x => x.Date === '2026-10-17')
    installFetch({
      tables: { echl_game_log: [{ game_id: Number(g.ID), game_date: '2026-10-17', home_team_id: Number(g.HomeID), away_team_id: Number(g.VisitorID), home_score: 0, away_score: 0, game_state: '7:05 pm EDT', game_status_code: 1 }] },
      scorebar: [],
    })
    const { body } = await get(handleECHL, '/echl/today?season=78')
    expect(body.map(x => x.gameId)).toEqual([Number(g.ID)])
    expect(urls().some(u => u.includes('numberofdaysahead=6'))).toBe(false)
  })

  it('nothing anywhere: an empty list, not an invented game', async () => {
    vi.setSystemTime(new Date('2026-07-01T16:00:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: [] })
    const { body } = await get(handleECHL, '/echl/today?season=76')
    expect(body).toEqual([])
  })
})

// ── /echl/live/:id and pollECHL for a game only the scorebar has ──────
// ECHL preseason game 26588 (ADK 74 v TR 99, 2026-10-08, season 77) is on
// /echl/today from the scorebar but never reaches echl_game_log. Before
// 2026-10 /echl/live/26588 answered null teams, 'pre' and 0-0 while the
// game was on, and the poll never saw it, so nobody got a push.
describe('a game only the scorebar has (ECHL preseason 26588)', () => {
  const liveScorebar = echlScorebar.map(g => (g.ID === '26588'
    ? { ...g, GameStatus: '2', GameStatusString: '2nd Period', GameStatusStringLong: '2nd Period 10:00', HomeGoals: '2', VisitorGoals: '1' }
    : g))
  const pbp = [
    { event: 'goal', details: { time: '5:00', period: { id: '1' }, team: { id: '74', abbreviation: 'echl - ADK' }, scoredBy: { id: '1', firstName: 'Home', lastName: 'One' }, assists: [], properties: {} } },
    { event: 'goal', details: { time: '8:00', period: { id: '1' }, team: { id: '99', abbreviation: 'echl - TR' }, scoredBy: { id: '2', firstName: 'Away', lastName: 'One' }, assists: [], properties: {} } },
    { event: 'goal', details: { time: '3:00', period: { id: '2' }, team: { id: '74', abbreviation: 'echl - ADK' }, scoredBy: { id: '3', firstName: 'Home', lastName: 'Two' }, assists: [], properties: {} } },
  ]

  it('/echl/live/26588: teams, score and live status from the scorebar row', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:30:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: liveScorebar, pbp })
    const { status, body } = await get(handleECHL, '/echl/live/26588')
    expect(status).toBe(200)
    expect(body).toMatchObject({ gameId: 26588, homeTeamId: 74, awayTeamId: 99, homeScore: 2, awayScore: 1, gameStatus: 'live' })
    expect(body.events).toHaveLength(3)
  })

  it('/echl/live/26588 once final: the scorebar score, cached for an hour', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:30:00Z'))
    const finalScorebar = liveScorebar.map(g => (g.ID === '26588'
      ? { ...g, GameStatus: '4', GameStatusString: 'Final', GameStatusStringLong: 'Final SO', HomeGoals: '3', VisitorGoals: '2' }
      : g))
    installFetch({ tables: { echl_game_log: [] }, scorebar: finalScorebar, pbp })
    const env = makeEnv()
    const putSpy = vi.spyOn(env.CACHE, 'put')
    const res = await handleECHL(makeRequest('/echl/live/26588'), env, makeCtx(), new URL('https://example.com/echl/live/26588'))
    expect(await res.json()).toMatchObject({ homeTeamId: 74, awayTeamId: 99, homeScore: 3, awayScore: 2, gameStatus: 'final' })
    expect(putSpy).toHaveBeenCalledWith('echl:live:26588', expect.any(String), { expirationTtl: 3600 })
  })

  it('a game game_log never had still answers as before: null teams, pre, 0-0', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:30:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: liveScorebar, pbp })
    const { body } = await get(handleECHL, '/echl/live/99999')
    expect(body).toMatchObject({ homeTeamId: null, awayTeamId: null, homeScore: 0, awayScore: 0, gameStatus: 'pre' })
  })

  it('pollECHL: the game is polled and its followers get the puck-drop push', async () => {
    vi.setSystemTime(new Date('2026-10-08T23:30:00Z'))
    installFetch({ tables: { echl_game_log: [] }, scorebar: liveScorebar, pbp })
    const subs = [
      { endpoint: 'https://push.example/adk', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'ECHL:ADK' },
      { endpoint: 'https://push.example/tr',  keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'ECHL:TR' },
    ]
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    await pollECHL(env)
    expect(urls().some(u => u.includes('view=gameCenterPlayByPlay') && u.includes('game_id=26588'))).toBe(true)
    expect(urls().some(u => u.includes('game_id=26589'))).toBe(false) // the other game is still 'pre'
    const sent = sendPushMock.mock.calls.map(([s, p]) => [s.endpoint, p.tag])
    expect(sent.filter(([, tag]) => tag === 'echl-start-26588')).toEqual([
      ['https://push.example/adk', 'echl-start-26588'],
      ['https://push.example/tr',  'echl-start-26588'],
    ])
    expect(sent.some(([, tag]) => tag.startsWith('echl-goal-'))).toBe(true)
  })
})
