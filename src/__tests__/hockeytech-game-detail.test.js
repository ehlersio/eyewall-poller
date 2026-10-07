// src/__tests__/hockeytech-game-detail.test.js
// Contract C6 (audit 2026-10-06 Phase 3): game-box `goals`/`penaltyShots`
// for PWHL, AHL and ECHL from {league}_goal_on_ice / {league}_penalty_shots,
// and `winProb` on the three schedule routes from {league}_game_win_probs.
// Goal and penalty-shot shapes follow the real HockeyTech feed (AHL
// 1029013's gameSummary goals, AHL 1029088's ahl_penalty_shots row).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolveAHLSeason: vi.fn().mockResolvedValue({ seasonId: 94, seasonType: 'regular' }),
    getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 94: 'regular' }),
    resolveECHLSeason: vi.fn().mockResolvedValue({ seasonId: 77, seasonType: 'regular' }),
    getAllECHLSeasonTypes: vi.fn().mockResolvedValue({ 77: 'regular' }),
    resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
  }
})

import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'
import { handlePWHL } from '../pwhl.js'
import { buildGoals, buildPenaltyShots, goalStrength, periodClock, withWinProbs } from '../hockeytechGameDetail.js'

const person = (id, firstName, lastName) => ({ id, firstName, lastName, jerseyNumber: 9 })
const flags = (over = {}) => ({ is_power_play: false, is_short_handed: false, is_empty_net: false, is_penalty_shot: false, ...over })

// Two goals as gameSummary lists them (AHL 1029013's shape): WBS at 1:15
// of the 1st, even strength; HER on the power play at 12:03 of the 2nd.
const summary = {
  homeTeam: { info: { id: 319 }, skaters: [{ info: person(9223, 'Gabe', 'Klassen') }, { info: person(7024, 'Louie', 'Belpedio') }], goalies: [] },
  visitingTeam: { info: { id: 316 }, skaters: [{ info: person(7017, 'Joona', 'Koppanen') }, { info: person(10962, 'Tanner', 'Howe') }], goalies: [{ info: person(10944, 'Riley', 'Mercer') }] },
  periods: [
    { info: { id: '1' }, goals: [{
      game_goal_id: '153118', team: { id: 316 }, period: { id: '1' }, time: '1:15',
      scoredBy: person(7017, 'Joona', 'Koppanen'), assists: [person(10962, 'Tanner', 'Howe'), person(9984, 'Aidan', 'McDonough')],
      properties: { isPowerPlay: '0', isShortHanded: '0', isEmptyNet: '0', isPenaltyShot: '0' },
    }] },
    { info: { id: '2' }, goals: [{
      game_goal_id: '153120', team: { id: 319 }, period: { id: '2' }, time: '12:03',
      scoredBy: person(9223, 'Gabe', 'Klassen'), assists: [],
      properties: { isPowerPlay: '1', isShortHanded: '0', isEmptyNet: '0', isPenaltyShot: '0' },
    }] },
  ],
}

const onIceRows = [
  { game_goal_id: 153118, scoring_team_id: 316, player_id: 10962, team_id: 316, on_ice_for: true, ...flags() },
  { game_goal_id: 153118, scoring_team_id: 316, player_id: 7017, team_id: 316, on_ice_for: true, ...flags() },
  { game_goal_id: 153118, scoring_team_id: 316, player_id: 7024, team_id: 319, on_ice_for: false, ...flags() },
  { game_goal_id: 153120, scoring_team_id: 319, player_id: 9223, team_id: 319, on_ice_for: true, ...flags({ is_power_play: true }) },
]

const expectedGoals = [
  { period: 1, time: '1:15', team_id: 316, scorer_id: 7017, scorer_name: 'Joona Koppanen', assist_ids: [10962, 9984], plus_player_ids: [7017, 10962], minus_player_ids: [7024], strength: 'EV' },
  { period: 2, time: '12:03', team_id: 319, scorer_id: 9223, scorer_name: 'Gabe Klassen', assist_ids: [], plus_player_ids: [9223], minus_player_ids: [], strength: 'PP' },
]

// AHL 1029088's real row: TEX's Dylan Hryckowian stopped by Riley Mercer, 1:32 of OT.
const shotRows = [
  { game_id: 1029088, team_id: 380, player_id: 10999, goalie_id: 10944, period_id: 4, time_seconds: 92, is_goal: false },
  { game_id: 1029088, team_id: 316, player_id: 7017, goalie_id: 11000, period_id: 2, time_seconds: 605, is_goal: true },
]

describe('hockeytechGameDetail helpers', () => {
  it('periodClock formats seconds into a period', () => {
    expect(periodClock(92)).toBe('1:32')
    expect(periodClock(605)).toBe('10:05')
    expect(periodClock(0)).toBe('0:00')
    expect(periodClock(null)).toBeNull()
  })

  it('goalStrength: PS, then PP/SH, then EN, else EV, from either flag spelling', () => {
    expect(goalStrength(flags())).toBe('EV')
    expect(goalStrength(flags({ is_power_play: true, is_empty_net: true }))).toBe('PP')
    expect(goalStrength(flags({ is_short_handed: true }))).toBe('SH')
    expect(goalStrength(flags({ is_empty_net: true }))).toBe('EN')
    expect(goalStrength(flags({ is_penalty_shot: true, is_power_play: true }))).toBe('PS')
    expect(goalStrength({ isPowerPlay: '1' })).toBe('PP')
    expect(goalStrength({ isPowerPlay: '0', isEmptyNet: '1' })).toBe('EN')
  })

  it('buildGoals merges the summary goals with goal_on_ice skaters, in game order', () => {
    expect(buildGoals(onIceRows, summary)).toEqual(expectedGoals)
  })

  it('buildGoals is empty when goal_on_ice has no rows for the game', () => {
    expect(buildGoals([], summary)).toEqual([])
    expect(buildGoals(null, summary)).toEqual([])
  })

  it('a summary goal with no on-ice rows (a penalty-shot goal) keeps its scorer and the summary strength', () => {
    const psSummary = { periods: [...summary.periods, { info: { id: '3' }, goals: [{
      game_goal_id: '153125', team: { id: 319 }, period: { id: '3' }, time: '4:00',
      scoredBy: person(9223, 'Gabe', 'Klassen'), assists: [], properties: { isPenaltyShot: '1' },
    }] }] }
    expect(buildGoals(onIceRows, psSummary)[2]).toEqual({
      period: 3, time: '4:00', team_id: 319, scorer_id: 9223, scorer_name: 'Gabe Klassen', assist_ids: [],
      plus_player_ids: [], minus_player_ids: [], strength: 'PS',
    })
  })

  it('without a summary, each goal_on_ice goal with period/time/scorer unknown', () => {
    expect(buildGoals(onIceRows, null)).toEqual(expectedGoals.map(g => ({
      ...g, period: null, time: null, scorer_id: null, scorer_name: null, assist_ids: [],
    })))
  })

  it('buildPenaltyShots: game order, names, goal or miss (the feed never says save vs wide)', () => {
    expect(buildPenaltyShots(shotRows, { 10999: 'Dylan Hryckowian' })).toEqual([
      { period: 2, time: '10:05', team_id: 316, shooter_id: 7017, shooter_name: null, goalie_id: 11000, result: 'goal' },
      { period: 4, time: '1:32', team_id: 380, shooter_id: 10999, shooter_name: 'Dylan Hryckowian', goalie_id: 10944, result: 'miss' },
    ])
  })

  it('withWinProbs adds winProb only to games that have one', () => {
    expect(withWinProbs([{ game_id: 1 }, { game_id: 2 }], { 2: 0.6606 })).toEqual([
      { game_id: 1 },
      { game_id: 2, winProb: { home: 0.6606, away: 0.3394, source: 'elo' } },
    ])
  })
})

// Supabase + HockeyTech stand-in: `tables` maps a full table name to rows
// or an HTTP status; a table it doesn't list is missing (PostgREST 404).
function mockBackends({ tables, summaryPayload = summary }) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (u.hostname.includes('hockeytech')) {
      if (u.searchParams.get('view') === 'gameSummary' && summaryPayload) return new Response(JSON.stringify(summaryPayload), { status: 200 })
      return new Response('', { status: 503 })
    }
    const name = u.pathname.slice('/rest/v1/'.length)
    const t = tables[name]
    if (t === undefined) return new Response(JSON.stringify({ code: 'PGRST205' }), { status: 404 })
    if (typeof t === 'number') return new Response('{}', { status: t })
    return new Response(JSON.stringify(t), { status: 200 })
  })
}
const requested = () => globalThis.fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)))

const LEAGUES = [
  { key: 'ahl', handle: handleAHL, season: 94 },
  { key: 'echl', handle: handleECHL, season: 77 },
]

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe.each(LEAGUES)('GET /$key/game-box goals and penaltyShots', (L) => {
  const get = (env = makeEnv()) => L.handle(makeRequest(`/${L.key}/game-box?gameId=1029013`), env, makeCtx(),
    new URL(`https://example.com/${L.key}/game-box?gameId=1029013`))
  const boxTables = (over = {}) => ({
    [`${L.key}_skater_game_box`]: [{ game_id: 1029013, player_id: 7017, team_id: 316, goals: 1 }],
    [`${L.key}_goalie_game_box`]: [{ game_id: 1029013, player_id: 10944, team_id: 316, saves: 30 }],
    [`${L.key}_game_log`]: [{ home_team_id: 319, away_team_id: 316 }],
    [`${L.key}_players`]: [{ player_id: 10999, first_name: 'Dylan', last_name: 'Hryckowian' }],
    ...over,
  })

  it('serves goals from goal_on_ice + the summary and named penalty shots', async () => {
    mockBackends({ tables: boxTables({ [`${L.key}_goal_on_ice`]: onIceRows, [`${L.key}_penalty_shots`]: shotRows }) })
    const cache = makeFakeCache()
    const res = await get(makeEnv({ CACHE: cache }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.goals).toEqual(expectedGoals)
    expect(body.penaltyShots).toEqual([
      { period: 2, time: '10:05', team_id: 316, shooter_id: 7017, shooter_name: 'Joona Koppanen', goalie_id: 11000, result: 'goal' },
      { period: 4, time: '1:32', team_id: 380, shooter_id: 10999, shooter_name: 'Dylan Hryckowian', goalie_id: 10944, result: 'miss' },
    ])
    expect(body.skaters[0].player_name).toBe('Joona Koppanen')
    expect(requested()).toContain(`https://mqgasjzywoibdgxjjkux.supabase.co/rest/v1/${L.key}_goal_on_ice?game_id=eq.1029013&order=game_goal_id.asc,player_id.asc&select=*`)
    expect(requested()).toContain(`https://mqgasjzywoibdgxjjkux.supabase.co/rest/v1/${L.key}_penalty_shots?game_id=eq.1029013&order=period_id.asc,time_seconds.asc&select=*`)
    // The shooter only the players table knows is looked up with the box rows.
    expect(requested().find(u => u.includes(`${L.key}_players?`))).toContain('player_id=in.(10999)')
    expect(cache._store.has(`${L.key}:gamebox:v2:1029013`)).toBe(true)
  })

  it('goal_on_ice not created yet (404): goals [], the box score still served', async () => {
    mockBackends({ tables: boxTables({ [`${L.key}_penalty_shots`]: [] }) })
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ goals: [], penaltyShots: [] })
    expect(body.skaters).toHaveLength(1)
  })

  it('a failing detail read never fails the box score', async () => {
    mockBackends({ tables: boxTables({ [`${L.key}_goal_on_ice`]: 500, [`${L.key}_penalty_shots`]: 503 }) })
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ goals: [], penaltyShots: [] })
  })
})

describe('GET /pwhl/game-box goals and penaltyShots', () => {
  const get = (env = makeEnv()) => handlePWHL(makeRequest('/pwhl/game-box?gameId=329'), env, makeCtx(),
    new URL('https://example.com/pwhl/game-box?gameId=329'))

  it('serves both arrays under the v3 key', async () => {
    mockBackends({ tables: {
      pwhl_skater_game_box: [{ game_id: 329, player_id: 7017, team_id: 316, goals: 1 }],
      pwhl_goalie_game_box: [],
      pwhl_goal_on_ice: onIceRows,
      pwhl_penalty_shots: shotRows.slice(1),
    } })
    const cache = makeFakeCache()
    const body = await (await get(makeEnv({ CACHE: cache }))).json()
    expect(body.goals).toEqual(expectedGoals)
    expect(body.penaltyShots).toEqual([
      { period: 2, time: '10:05', team_id: 316, shooter_id: 7017, shooter_name: 'Joona Koppanen', goalie_id: 11000, result: 'goal' },
    ])
    expect(cache._store.has('pwhl:game-box:v3:329')).toBe(true)
  })

  it('no rows for the game: empty arrays', async () => {
    mockBackends({ tables: { pwhl_skater_game_box: [], pwhl_goalie_game_box: [], pwhl_goal_on_ice: [], pwhl_penalty_shots: [] } })
    expect(await (await get()).json()).toEqual({ skaters: [], goalies: [], goals: [], penaltyShots: [] })
  })
})

describe('schedule winProb', () => {
  const games = [
    { game_id: 1029100, season_id: 94, game_date: '2026-10-04', home_team_id: 316, away_team_id: 307, home_score: 3, away_score: 2, game_status_code: 4, game_state: 'Final' },
    { game_id: 1029200, season_id: 94, game_date: '2026-10-11', home_team_id: 307, away_team_id: 316, home_score: 0, away_score: 0, game_status_code: 4, game_state: 'Final' },
  ]

  it.each(LEAGUES)('/$key/schedule rows carry the Elo winProb when one exists', async (L) => {
    mockBackends({ tables: {
      [`${L.key}_game_log`]: games,
      [`${L.key}_game_win_probs`]: [{ game_id: 1029100, home_win_prob: 0.6606 }],
    } })
    const cache = makeFakeCache()
    const res = await L.handle(makeRequest(`/${L.key}/schedule?teamId=316&season=${L.season}`), makeEnv({ CACHE: cache }), makeCtx(),
      new URL(`https://example.com/${L.key}/schedule?teamId=316&season=${L.season}`))
    const body = await res.json()
    expect(body[0].winProb).toEqual({ home: 0.6606, away: 0.3394, source: 'elo' })
    expect(body[1].winProb).toBeUndefined()
    expect(requested()).toContain(`https://mqgasjzywoibdgxjjkux.supabase.co/rest/v1/${L.key}_game_win_probs?season_id=eq.${L.season}&or=(home_team_id.eq.316,away_team_id.eq.316)&select=game_id,home_win_prob&order=game_id.asc&limit=200`)
    expect(cache._store.has(`${L.key}:schedule:v2:316:${L.season}`)).toBe(true)
  })

  it.each(LEAGUES)('/$key/schedule without a win-prob table still serves the schedule', async (L) => {
    mockBackends({ tables: { [`${L.key}_game_log`]: games } })
    const res = await L.handle(makeRequest(`/${L.key}/schedule?teamId=316&season=${L.season}`), makeEnv(), makeCtx(),
      new URL(`https://example.com/${L.key}/schedule?teamId=316&season=${L.season}`))
    expect(res.status).toBe(200)
    expect((await res.json()).every(g => g.winProb === undefined)).toBe(true)
  })

  it('/pwhl/schedule rows carry the Elo winProb when one exists', async () => {
    mockBackends({ tables: {
      pwhl_game_log: [{ game_id: 353, season_id: 8, home_team_id: 12, away_team_id: 2 }, { game_id: 354, season_id: 8, home_team_id: 2, away_team_id: 12 }],
      pwhl_game_win_probs: [{ game_id: 354, home_win_prob: 0.5123 }],
    } })
    const cache = makeFakeCache()
    const res = await handlePWHL(makeRequest('/pwhl/schedule?teamId=2&season=8'), makeEnv({ CACHE: cache }), makeCtx(),
      new URL('https://example.com/pwhl/schedule?teamId=2&season=8'))
    const body = await res.json()
    expect(body[0].winProb).toBeUndefined()
    expect(body[1].winProb).toEqual({ home: 0.5123, away: 0.4877, source: 'elo' })
    expect(cache._store.has('pwhl:schedule:v2:2:8')).toBe(true)
  })

  it('/pwhl/schedule still 502s when the game log read fails', async () => {
    mockBackends({ tables: { pwhl_game_log: 500, pwhl_game_win_probs: [] } })
    const res = await handlePWHL(makeRequest('/pwhl/schedule?teamId=2&season=8'), makeEnv(), makeCtx(),
      new URL('https://example.com/pwhl/schedule?teamId=2&season=8'))
    expect(res.status).toBe(502)
  })
})
