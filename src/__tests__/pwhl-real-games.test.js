// src/__tests__/pwhl-real-games.test.js
// PWHL routes and alerts replayed against real games (fixtures/pwhl-*),
// for the 2026-10-05 audit:
//   #2    /pwhl/game-box names every row from the game's own lineup
//   extra /pwhl/pbp names players who have since changed teams
//   #12   goaliePulled fires only for an extra-attacker pull

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import * as box329 from './fixtures/pwhl-329-game-box.js'
import * as pbp328 from './fixtures/pwhl-328-pbp.js'
import { events as pbp241 } from './fixtures/pwhl-241-pbp.js'

const sendPushMock = vi.hoisted(() => vi.fn())
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock }
})

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
  }
})

import { handlePWHL, pollPWHL } from '../pwhl.js'

const jsonp = (data) => ({ ok: true, status: 200, text: async () => `(${JSON.stringify(data)})`, json: async () => data })
const rows = (data) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)), text: async () => JSON.stringify(data) })
const DOWN = { ok: false, status: 503, text: async () => '', json: async () => ({}) }

function installFetch({ tables = {}, views = {} }) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    if (u.pathname.startsWith('/rest/v1/')) {
      const t = tables[u.pathname.slice('/rest/v1/'.length)]
      return rows(typeof t === 'function' ? t(u.searchParams) : (t ?? []))
    }
    const view = u.searchParams.get('view')
    if (view in views) return views[view] === DOWN ? DOWN : jsonp(views[view])
    return rows({})
  })
}

// pwhl_players filtered the way PostgREST would for player_id=in.(...) /
// team_id=in.(...).
const playersTable = (all) => (params) => {
  const inList = (f) => f.slice(4, -1).split(',').map(Number)
  if (params.get('player_id')) return all.filter(p => inList(params.get('player_id')).includes(p.player_id))
  if (params.get('team_id')) return all.filter(p => inList(params.get('team_id')).includes(p.team_id))
  return all
}

async function get(path, env = makeEnv()) {
  const res = await handlePWHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2025-12-31T01:00:00Z'))
  sendPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── #2 ────────────────────────────────────────────────────────────────
describe('/pwhl/game-box names every row (#2)', () => {
  const names = (body) => Object.fromEntries([...body.skaters, ...body.goalies].map(r => [r.player_id, r.player_name]))

  it('game 329: all 42 rows named from the gameSummary, including the 14 no longer on BOS/NY', async () => {
    const onRoster = new Set(box329.currentRoster.map(p => p.player_id))
    const moved = [...box329.skaterRows, ...box329.goalieRows].filter(r => !onRoster.has(r.player_id))
    expect(moved).toHaveLength(14)

    installFetch({
      tables: {
        pwhl_skater_game_box: box329.skaterRows,
        pwhl_goalie_game_box: box329.goalieRows,
        pwhl_players: playersTable(box329.currentRoster),
      },
      views: { gameSummary: box329.gameSummary },
    })
    const { status, body } = await get('/pwhl/game-box?gameId=329')
    expect(status).toBe(200)
    const byId = names(body)
    expect(Object.keys(byId)).toHaveLength(42)
    expect(Object.values(byId).every(Boolean)).toBe(true)
    expect(byId[36]).toBe('Jessie Eldridge')
    expect(byId[182]).toBe('Hadley Hartmetz')
    // Rows otherwise unchanged (team, jersey, stats).
    expect(body.skaters.find(r => r.player_id === 36)).toMatchObject({ team_id: 1, jersey_number: 18, goals: 1, assists: 1 })
  })

  it('HockeyTech down: names whoever pwhl_players knows by id, null for the rest, cached 5 minutes under the v2 key', async () => {
    const env = makeEnv()
    const put = vi.spyOn(env.CACHE, 'put')
    installFetch({
      tables: {
        pwhl_skater_game_box: box329.skaterRows,
        pwhl_goalie_game_box: box329.goalieRows,
        pwhl_players: playersTable(box329.currentRoster),
      },
      views: { gameSummary: DOWN },
    })
    const { body } = await get('/pwhl/game-box?gameId=329', env)
    const byId = names(body)
    expect(Object.values(byId).filter(n => n == null)).toHaveLength(14)
    expect(byId[36]).toBeNull()
    expect(put).toHaveBeenCalledWith('pwhl:game-box:v2:329', expect.any(String), { expirationTtl: 300 })
  })
})

// ── extra: /pwhl/pbp ─────────────────────────────────────────────────
describe('/pwhl/pbp names players who have since moved', () => {
  const penalties = (body) => body.events
    .filter(e => e.event_type === 'penalty')
    .map(e => [e.period_id, e.time_seconds, e.team_id, e.player_name])

  it('game 328: the P2 penalties by Taylor House and Alexa Vasko are named', async () => {
    installFetch({
      tables: {
        pwhl_pbp_events: pbp328.pbpRows,
        pwhl_game_log: [pbp328.game],
        pwhl_players: playersTable(pbp328.currentRoster),
      },
      views: { gameSummary: pbp328.gameSummary },
    })
    const { body } = await get('/pwhl/pbp?gameId=328')
    expect(penalties(body)).toEqual([
      [2, 321, 5, 'Taylor House'],
      [2, 707, 5, 'Alexa Vasko'],
      [3, 369, 5, expect.any(String)],
    ])
    expect(body.events.every(e => e._home_team_id === 5 && e._away_team_id === 6)).toBe(true)
  })

  it('HockeyTech down: falls back to pwhl_players by id and leaves the unknown unnamed', async () => {
    installFetch({
      tables: {
        pwhl_pbp_events: pbp328.pbpRows,
        pwhl_game_log: [pbp328.game],
        pwhl_players: playersTable([...pbp328.currentRoster, { player_id: 217, first_name: 'Taylor', last_name: 'House', team_id: 3 }]),
      },
      views: { gameSummary: DOWN },
    })
    const { body } = await get('/pwhl/pbp?gameId=328')
    const rows = penalties(body)
    expect(rows[0]).toEqual([2, 321, 5, 'Taylor House'])
    expect(rows[1][3]).toBeNull()
  })
})

// ── #12 ───────────────────────────────────────────────────────────────
describe('PWHL goaliePulled alert (#12)', () => {
  const subs = [
    { endpoint: 'https://push.example/min', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'PWHL:MIN' },
    { endpoint: 'https://push.example/tor', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'PWHL:TOR' },
  ]
  const liveRow = { game_id: 241, home_team_id: 6, away_team_id: 2, home_score: 0, away_score: 0, game_state: 'In Progress', game_status_code: 2 }

  it('game 241 polled after every event: only TOR\'s P3 14:15 pull alerts, not MIN\'s tied P1 delayed-penalty pull', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    for (let n = 1; n <= pbp241.length; n++) {
      installFetch({
        tables: { pwhl_game_log: [liveRow] },
        views: { scorebar: { SiteKit: { Scorebar: [] } }, gameCenterPlayByPlay: pbp241.slice(0, n) },
      })
      await pollPWHL(env)
    }
    const pulls = sendPushMock.mock.calls
      .map(([s, p]) => ({ to: s.endpoint, title: p.title, body: p.body }))
      .filter(p => p.title.includes('pulled'))
    expect(pulls).toEqual([
      { to: 'https://push.example/min', title: '🥅 TOR pulled their goalie!', body: '6-on-5 — empty net opportunity for MIN!' },
    ])
  })
})
