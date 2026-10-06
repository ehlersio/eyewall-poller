// src/__tests__/hockeytech-real-games.test.js
// AHL routes and alerts replayed against real games (fixtures/ahl-*), for
// the 2026-10-05 audit's HockeyTech findings:
//   #2  /ahl/game-box names every row from the game's own lineup
//   #12 goaliePulled fires only for an extra-attacker pull
//   #16 standings / prediction streaks split OT/SO losses from regulation
//   #17 /ahl/live counts the shootout: shooterTeam, period SO, final score
//   #32 /ahl/players returns the whole team, all of it named

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import * as box1029013 from './fixtures/ahl-1029013-game-box.js'
import { events as pbp1029094 } from './fixtures/ahl-1029094-pbp.js'
import { events as pbp1029078 } from './fixtures/ahl-1029078-pbp.js'
import * as her from './fixtures/ahl-her-2025-26-players.js'

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
    getAllAHLSeasonTypes: vi.fn().mockResolvedValue({ 90: 'regular', 92: 'playoffs', 94: 'regular' }),
    getAllAHLSeasons: vi.fn().mockResolvedValue([
      { seasonId: 90, seasonType: 'regular', startYear: 2025, startDate: '2025-10-07' },
      { seasonId: 94, seasonType: 'regular', startYear: 2026, startDate: '2026-10-02' },
    ]),
  }
})

import { handleAHL, pollAHL } from '../ahl.js'

const jsonp = (data) => ({ ok: true, status: 200, text: async () => `(${JSON.stringify(data)})`, json: async () => data })
const rows = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })

// Dispatches by Supabase table / HockeyTech view; anything unlisted is [].
function installFetch({ tables = {}, views = {} }) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (u.hostname === 'openrouter.ai') return rows({ choices: [{ message: { content: 'Fixture narrative.' } }] })
    if (u.pathname.startsWith('/rest/v1/')) {
      const table = u.pathname.slice('/rest/v1/'.length)
      const t = tables[table]
      return rows(typeof t === 'function' ? t(u.searchParams) : (t ?? []))
    }
    const view = u.searchParams.get('view')
    if (view in views) {
      const v = views[view]
      return typeof v === 'function' ? v() : jsonp(v)
    }
    return rows({})
  })
}

async function get(path, env = makeEnv()) {
  const res = await handleAHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
  return { status: res.status, body: await res.json() }
}

const supabaseUrls = () => globalThis.fetch.mock.calls.map(([u]) => String(u)).filter(u => u.includes('/rest/v1/'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T01:00:00Z'))
  sendPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── #2 ────────────────────────────────────────────────────────────────
describe('/ahl/game-box names every row from the game itself (#2)', () => {
  const byId = (body) => Object.fromEntries([...body.skaters, ...body.goalies].map(r => [r.player_id, r.player_name]))

  it('names all 40 rows of game 1029013 from its gameSummary, including Gabe Klassen', async () => {
    installFetch({
      tables: {
        ahl_skater_game_box: box1029013.skaterRows,
        ahl_goalie_game_box: box1029013.goalieRows,
        ahl_game_log: [{ home_team_id: 319, away_team_id: 316 }],
        ahl_players: () => { throw new Error('players lookup not needed when the summary names everyone') },
      },
      views: { gameSummary: box1029013.gameSummary },
    })
    const { status, body } = await get('/ahl/game-box?gameId=1029013')
    expect(status).toBe(200)
    const names = byId(body)
    expect(Object.keys(names)).toHaveLength(40)
    expect(Object.values(names).every(Boolean)).toBe(true)
    expect(names[9223]).toBe('Gabe Klassen')
    expect(supabaseUrls().some(u => u.includes('ahl_players'))).toBe(false)
  })

  it('falls back to ahl_players by id when HockeyTech is unreachable, and leaves the unknown unnamed', async () => {
    const env = makeEnv()
    installFetch({
      tables: {
        ahl_skater_game_box: box1029013.skaterRows,
        ahl_goalie_game_box: box1029013.goalieRows,
        ahl_game_log: [{ home_team_id: 319, away_team_id: 316 }],
        ahl_players: [{ player_id: 9223, first_name: 'Gabe', last_name: 'Klassen' }],
      },
      views: { gameSummary: () => ({ ok: false, status: 503, text: async () => '' }) },
    })
    const { body } = await get('/ahl/game-box?gameId=1029013', env)
    const names = byId(body)
    expect(names[9223]).toBe('Gabe Klassen')
    // Nobody else is in the stub table: null, never a guessed "#jersey".
    expect(Object.values(names).filter(n => n == null)).toHaveLength(39)
    // Cached briefly, so the names fill in once HockeyTech is back.
    const put = vi.spyOn(env.CACHE, 'put')
    await env.CACHE.delete('ahl:gamebox:1029013')
    await get('/ahl/game-box?gameId=1029013', env)
    expect(put).toHaveBeenCalledWith('ahl:gamebox:1029013', expect.any(String), { expirationTtl: 300 })
  })
})

// ── #12 ───────────────────────────────────────────────────────────────
describe('AHL goaliePulled alert (#12)', () => {
  const subs = [
    { endpoint: 'https://push.example/bak', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'AHL:BAK' },
    { endpoint: 'https://push.example/hsk', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'AHL:HSK' },
  ]
  const liveRow = { game_id: 1029094, home_team_id: 437, away_team_id: 402, home_score: 0, away_score: 0, game_state: 'In Progress', game_status_code: 2 }

  async function replay(cuts) {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    for (const n of cuts) {
      installFetch({
        tables: { ahl_game_log: [liveRow] },
        views: { scorebar: { SiteKit: { Scorebar: [] } }, gameCenterPlayByPlay: pbp1029094.slice(0, n) },
      })
      await pollAHL(env)
    }
    return sendPushMock.mock.calls
      .map(([s, p]) => ({ to: s.endpoint, title: p.title, body: p.body }))
      .filter(p => p.title.includes('pulled'))
  }

  it('game 1029094 polled after every event: only HSK\'s two late 3rd-period pulls alert, not the P1 delayed-penalty pulls', async () => {
    const cuts = pbp1029094.map((_, i) => i + 1)
    expect(await replay(cuts)).toEqual([
      { to: 'https://push.example/bak', title: '🥅 HSK pulled their goalie!', body: '6-on-5 — empty net opportunity for BAK!' },
      { to: 'https://push.example/bak', title: '🥅 HSK pulled their goalie!', body: '6-on-5 — empty net opportunity for BAK!' },
    ])
  })

  it('a pull already over when the poll first sees it (goalie back in the same feed) sends nothing', async () => {
    // Up to the 18:22 pull's return at 19:08, in one tick.
    const back = pbp1029094.findIndex(e => e.event === 'goalie_change' && e.details.time === '19:08' && e.details.goalieComingIn)
    expect(back).toBeGreaterThan(0)
    expect(await replay([back + 1])).toEqual([])
  })
})

// ── #16 ───────────────────────────────────────────────────────────────
describe('/ahl/standings splits OT/SO losses (#16)', () => {
  // Real 2026-27 opening-weekend game_log rows (season 94) and the
  // team_seasons records for TEX (380) and GR (328).
  const games = [
    { game_id: 1029093, home_team_id: 373, away_team_id: 328, home_score: 5, away_score: 4, ended_in: 'OT' },
    { game_id: 1029088, home_team_id: 380, away_team_id: 389, home_score: 3, away_score: 4, ended_in: 'SO' },
    { game_id: 1029078, home_team_id: 380, away_team_id: 389, home_score: 4, away_score: 3, ended_in: 'SO' },
    { game_id: 1029073, home_team_id: 373, away_team_id: 328, home_score: 2, away_score: 5, ended_in: null },
  ]
  const teamSeasons = [
    { team_id: 380, gp: 2, wins: 1, losses: 0, ot_losses: 0, shootout_losses: 1, points: 3 },
    { team_id: 328, gp: 2, wins: 1, losses: 0, ot_losses: 1, shootout_losses: 0, points: 3 },
    { team_id: 389, gp: 2, wins: 1, losses: 0, ot_losses: 0, shootout_losses: 1, points: 3 },
  ]

  it('TEX after a shootout loss and GR after an OT loss read OT1, not L1', async () => {
    installFetch({ tables: { ahl_team_seasons: teamSeasons, ahl_game_log: games } })
    const { body } = await get('/ahl/standings?season=94')
    const row = (id) => body.find(r => r.team_id === id)
    expect(row(380)).toMatchObject({ l10W: 1, l10L: 0, l10OTL: 1, streakType: 'OT', streakCount: 1 })
    expect(row(328)).toMatchObject({ l10W: 1, l10L: 0, l10OTL: 1, streakType: 'OT', streakCount: 1 })
    expect(row(389)).toMatchObject({ l10W: 1, l10L: 0, l10OTL: 1, streakType: 'W', streakCount: 1 })
    expect(supabaseUrls().find(u => u.includes('ahl_game_log'))).toContain('ended_in')
  })
})

describe('/ahl/prediction streaks split OT/SO losses (#16)', () => {
  it('HER vs TEX (1029113, 2026-10-10): TEX\'s streak after a shootout loss is OT1, and the prompt says what OT1 means', async () => {
    const games = [
      { game_id: 1029088, home_team_id: 380, away_team_id: 389, home_score: 3, away_score: 4, ended_in: 'SO' },
      { game_id: 1029078, home_team_id: 380, away_team_id: 389, home_score: 4, away_score: 3, ended_in: 'SO' },
    ]
    installFetch({
      tables: {
        ahl_game_log: (params) => (params.get('game_id')
          ? [{ game_id: 1029113, season_id: 94, home_team_id: 319, away_team_id: 380 }]
          : games),
        ahl_team_seasons: (params) => (params.get('season_id') === 'eq.94'
          ? [{ team_id: 380, gp: 2, wins: 1, losses: 0, ot_losses: 0, shootout_losses: 1, points: 3 }]
          : []),
      },
    })
    const { status, body } = await get('/ahl/prediction?gameId=1029113')
    expect(status).toBe(200)
    expect(body.awayStreak).toBe('OT1')
    const ai = globalThis.fetch.mock.calls.find(([u]) => String(u).includes('openrouter.ai'))
    expect(ai[1].body).toContain('Current streak: OT1 (consecutive overtime/shootout losses)')
  })
})

// ── #17 ───────────────────────────────────────────────────────────────
describe('/ahl/live counts the shootout (#17)', () => {
  // Real: game_log row for 1029078 (TEX won 4-3 in a shootout).
  const finalRow = { game_id: 1029078, home_team_id: 380, away_team_id: 389, home_score: 4, away_score: 3, game_state: 'Final', game_status_code: 4 }

  it('a final shootout game reports the 4-3 final, and every shootout attempt has its team and period SO', async () => {
    installFetch({
      tables: { ahl_game_log: [finalRow] },
      views: { gameCenterPlayByPlay: pbp1029078 },
    })
    const { body } = await get('/ahl/live/1029078')
    expect(body).toMatchObject({ gameStatus: 'final', homeTeamId: 380, awayTeamId: 389, homeScore: 4, awayScore: 3 })
    const so = body.events.filter(e => e.eventType === 'shootout')
    expect(so.map(e => [e.teamId, e.period, e.isGoal])).toEqual([
      [389, 7, false], [380, 7, false], [389, 7, false], [380, 7, true], [389, 7, false],
    ])
    expect(so[3].shooter).toMatchObject({ firstName: 'Mike', lastName: 'Sgarbossa' })
    // Regulation goals still count to 3-3; only the final takes the row's score.
    const goals = body.events.filter(e => e.eventType === 'goal')
    expect(goals.filter(g => g.teamId === 380)).toHaveLength(3)
    expect(goals.filter(g => g.teamId === 389)).toHaveLength(3)
  })

  it('a game still in progress keeps counting goal events', async () => {
    installFetch({
      tables: { ahl_game_log: [{ ...finalRow, home_score: 9, away_score: 9, game_state: 'In Progress', game_status_code: 2 }] },
      views: { gameCenterPlayByPlay: pbp1029078.filter(e => e.event === 'goal'), scorebar: { SiteKit: { Scorebar: [] } } },
    })
    const { body } = await get('/ahl/live/1029078')
    expect(body).toMatchObject({ gameStatus: 'live', homeScore: 3, awayScore: 3 })
  })
})

// ── #32 ───────────────────────────────────────────────────────────────
describe('/ahl/players returns the whole team (#32)', () => {
  it('Hershey 2025-26: all 45 skaters and 4 goalies, every one named', async () => {
    installFetch({
      tables: {
        ahl_player_seasons: her.skaterSeasons,
        ahl_goalie_seasons: her.goalieSeasons,
        ahl_players: (params) => {
          const f = params.get('player_id')
          if (!f) return [] // current-roster read: not what names the stats rows
          const ids = f.slice(4, -1).split(',').map(Number)
          return her.players.filter(p => ids.includes(p.player_id))
        },
      },
    })
    const { body } = await get('/ahl/players?teamId=319&season=90')
    expect(body.skaters).toHaveLength(45)
    expect(body.goalies).toHaveLength(4)
    expect([...body.skaters, ...body.goalies].every(r => r.player_name)).toBe(true)
    const names = body.skaters.map(s => s.player_name)
    for (const n of ['Connor Mayer', 'Garrett Pyke', 'Alex Gaffney', 'Romain Rodzinski']) expect(names).toContain(n)
    const reads = supabaseUrls()
    expect(reads.filter(u => /ahl_(player|goalie)_seasons/.test(u)).every(u => !u.includes('limit='))).toBe(true)
  })
})
