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
  }
})

import { pollPWHL, PWHL_TEAM_CODES } from '../pwhl.js'

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

function installFetch(row) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = String(input)
    if (url.includes('/rest/v1/pwhl_game_log')) return { ok: true, json: async () => [row] }
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

  it('a game already final the first time it is polled gets no game-over push', async () => {
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'k', CACHE: makeFakeCache({ 'push:subs': subs }) })
    installFetch(finalRow())
    await pollPWHL(env)
    expect(sendPushMock).not.toHaveBeenCalled()
    expect(pbpFetched()).toBe(false)
  })
})
