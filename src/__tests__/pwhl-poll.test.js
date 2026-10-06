// src/__tests__/pwhl-poll.test.js
// pollPWHL's game-over push. pollPWHL used to hand only live games to
// pollPWHLGame, so the final-score push inside it could never fire. Same
// behavior pinned for AHL/ECHL in hockeytech-leagues.characterization.test.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeFakeCache } from './route-harness.js'

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
    // current regular season 8, 2026-27 preseason 10, next regular season 11
    getPWHLScheduleSeasonIds: vi.fn().mockResolvedValue([8, 10, 11]),
  }
})

import { pollPWHL, PWHL_TEAM_CODES } from '../pwhl.js'
import { getPWHLScheduleSeasonIds } from '../seasons.js'

const GAME_ID = 300
const HOME = 1 // BOS
const AWAY = 6 // TOR
const PBP = [{ event: 'shot', details: { time: '1:00', period: { id: '1' } } }]

const gameRow = (overrides = {}) => ({
  game_id: GAME_ID, home_team_id: HOME, away_team_id: AWAY,
  home_score: 1, away_score: 0, game_state: 'In Progress', game_status_code: 2, ...overrides,
})
const finalRow = () => gameRow({ home_score: 3, away_score: 1, game_state: 'Final', game_status_code: 4 })

const subs = [
  { endpoint: 'https://push.example/home', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `PWHL:${PWHL_TEAM_CODES[HOME]}` },
  { endpoint: 'https://push.example/away', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `PWHL:${PWHL_TEAM_CODES[AWAY]}` },
]

function installFetch(row, scorebar = []) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input)
    if (url.includes('/rest/v1/pwhl_game_log')) return { ok: true, json: async () => [row] }
    if (url.includes('view=scorebar')) return { ok: true, json: async () => ({ SiteKit: { Scorebar: scorebar } }) }
    if (url.includes('gameCenterPlayByPlay')) return { ok: true, text: async () => `(${JSON.stringify(PBP)})` }
    return { ok: true, json: async () => ({}), text: async () => '({})' }
  })
}

const sent = () => sendPushMock.mock.calls.map(([s, p]) => ({ to: s.endpoint, title: p.title, tag: p.tag }))
const pbpFetched = () => globalThis.fetch.mock.calls.some(([u]) => String(u).includes('gameCenterPlayByPlay'))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-15T23:30:00Z')) // in season (Nov–Jun)
  sendPushMock.mockReset().mockResolvedValue('ok')
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pollPWHL failures', () => {
  // The cron tick records a poll that throws (health:cron:pwhl, ops.js);
  // one that swallowed its own error looked healthy forever.
  it('rethrows a failed tick so the cron can record it', async () => {
    installFetch(gameRow())
    vi.mocked(getPWHLScheduleSeasonIds).mockRejectedValueOnce(new Error('bootstrap down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = makeEnv({ CACHE: makeFakeCache({ 'push:subs': subs }), VAPID_PRIVATE_KEY: 'k' })
    await expect(pollPWHL(env)).rejects.toThrow('bootstrap down')
  })
})

describe('pollPWHL slate query', () => {
  // The AHL/ECHL poll's identical read stopped at 10 unordered rows (audit
  // 2026-10-06, AHL/ECHL F1); the PWHL copy keeps the same shape.
  it('reads today\'s games in game_id order without the old 10-row cap', async () => {
    installFetch(gameRow())
    const env = makeEnv({ CACHE: makeFakeCache({ 'push:subs': subs }), VAPID_PRIVATE_KEY: 'k' })
    await pollPWHL(env)
    const url = globalThis.fetch.mock.calls.map(([u]) => String(u)).find(u => u.includes('/rest/v1/pwhl_game_log?game_date='))
    expect(url).toContain('&order=game_id.asc')
    expect(url).not.toContain('limit=10')
  })
})

// Regression (audit 2026-10-06, PWHL F1): the slate read filtered on
// resolvePWHLSeason()'s id alone -- by design the most recent REGULAR
// season -- so a game logged under a playoffs or preseason season_id was
// never polled and nobody got a push for it. A Nov-Jun month gate on top
// would have skipped an October preseason outright.
describe('pollPWHL season ids', () => {
  it('a preseason game logged under the preseason id, in October, is polled and gets its puck-drop push', async () => {
    vi.setSystemTime(new Date('2026-10-25T23:30:00Z'))
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    const preseasonRow = gameRow({ season_id: 10 })
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input)
      if (url.includes('/rest/v1/pwhl_game_log')) {
        // Only the schedule-wide filter finds the row; season_id=eq.8 would not.
        return { ok: true, json: async () => (url.includes('season_id=in.(8,10,11)') ? [preseasonRow] : []) }
      }
      if (url.includes('view=scorebar')) return { ok: true, json: async () => ({ SiteKit: { Scorebar: [] } }) }
      if (url.includes('gameCenterPlayByPlay')) return { ok: true, text: async () => `(${JSON.stringify(PBP)})` }
      return { ok: true, json: async () => ({}), text: async () => '({})' }
    })

    await pollPWHL(env)

    const slateUrl = globalThis.fetch.mock.calls.map(([u]) => String(u)).find(u => u.includes('/rest/v1/pwhl_game_log'))
    expect(slateUrl).toContain('game_date=eq.2026-10-25&season_id=in.(8,10,11)')
    expect(pbpFetched()).toBe(true)
    expect(sent().map(p => p.tag)).toEqual([`pwhl-start-${GAME_ID}`, `pwhl-start-${GAME_ID}`])
  })
})

describe('pollPWHL game-over push', () => {
  it('a game followed live gets exactly one game-over push when it goes final', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })

    installFetch(gameRow())
    await pollPWHL(env)
    expect(sent().map(p => p.tag)).toEqual([`pwhl-start-${GAME_ID}`, `pwhl-start-${GAME_ID}`])

    sendPushMock.mockClear()
    installFetch(finalRow())
    await pollPWHL(env)
    expect(sent()).toEqual([
      { to: 'https://push.example/home', title: '🏆 BOS Win! BOS 3–1 TOR', tag: `pwhl-win-${GAME_ID}-home` },
      { to: 'https://push.example/away', title: 'Final: TOR 1–3 BOS', tag: `pwhl-final-${GAME_ID}-away` },
    ])

    sendPushMock.mockClear()
    globalThis.fetch.mockClear()
    await pollPWHL(env)
    expect(sendPushMock).not.toHaveBeenCalled()
    expect(pbpFetched()).toBe(false)
  })

  // The scorebar's short GameStatusString says "Final" whatever the ending;
  // its long form carries OT/SO.
  it('says Final/SO and (SO) for a game decided in a shootout', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    installFetch(gameRow())
    await pollPWHL(env)

    sendPushMock.mockClear()
    await env.CACHE.delete('pwhl:scorebar') // its 60s TTL, run out
    installFetch(gameRow(), [{
      ID: String(GAME_ID), GameStatus: '4', GameStatusString: 'Final', GameStatusStringLong: 'Final SO',
      HomeGoals: '3', VisitorGoals: '2',
    }])
    await pollPWHL(env)
    expect(sent().map(p => p.title)).toEqual(['🏆 BOS Win! BOS 3–2 TOR (SO)', 'Final/SO: TOR 2–3 BOS'])
  })

  it('a game already final the first time it is polled gets no game-over push', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    installFetch(finalRow())
    await pollPWHL(env)
    expect(sendPushMock).not.toHaveBeenCalled()
    expect(pbpFetched()).toBe(false)
  })
})
