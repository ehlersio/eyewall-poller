// src/__tests__/goalReplay.test.js
// GET /nhl/goal-replay/:gameId/:eventId (goalReplay.js): the tracking
// geometry (coordinates, attacked net, goal frame -- the same rules as
// eyewall-pipeline's goal_of_week.py) and the route's fetch/cache/404
// behaviour. Frames are synthetic, in the feed's shape: inches from a rink
// corner, 10 Hz, the puck the object with no playerId.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeCache } from './route-harness.js'
import {
  toFeet, attacksRight, goalFrame, compactReplay, handleGoalReplay,
  TTL_FINAL, TTL_LIVE, TTL_MISSING,
} from '../goalReplay.js'

// Play-by-play feet -> the feed's inches
const inches = (x, y) => ({ x: (x + 100) * 12, y: (42.5 - y) * 12 })

function frame(puck, players = []) {
  const onIce = {}
  if (puck) onIce['1'] = { id: 1, playerId: '', ...inches(...puck), sweaterNumber: '', teamAbbrev: '' }
  players.forEach(([id, pid, num, team, x, y]) => {
    onIce[String(id)] = { id, playerId: pid, sweaterNumber: num, teamAbbrev: team, ...inches(x, y) }
  })
  return { timeStamp: 1, onIce }
}

// Puck carried straight in on the right-hand net, then sitting in it
const rushRight = (n = 20) => [
  ...Array.from({ length: n }, (_, i) => frame([40 + (50 * i) / n, 0])),
  frame([90, 0]),
  frame([90, 0]),
]

describe('toFeet', () => {
  it('converts corner inches to play-by-play feet', () => {
    expect(toFeet({ x: 1200, y: 510 })).toEqual([0, 0])
    expect(toFeet({ x: 2268, y: 414 })).toEqual([89, 8])
  })
})

describe('attacked net and goal frame', () => {
  it('finds the right-hand net and the first frame in it', () => {
    const frames = rushRight()
    expect(attacksRight(frames)).toBe(true)
    expect(goalFrame(frames, true)).toBe(20)
  })

  it('mirrors for the left-hand net', () => {
    const frames = rushRight().map(f => {
      const p = f.onIce['1']
      return frame([-(p.x / 12 - 100), -(42.5 - p.y / 12)])
    })
    expect(attacksRight(frames)).toBe(false)
    expect(goalFrame(frames, false)).toBe(20)
  })

  it('does not count a puck carried behind the net', () => {
    const frames = [
      frame([80, -8]), frame([88, -8]), frame([92, -6]), frame([95, -2]), frame([95, 1]),
      frame([85, 0]), frame([90, 0]),
    ]
    expect(goalFrame(frames, true)).toBe(6)
  })

  it('finds a shot tracking lost, turning up noisy inside the net', () => {
    // the 2026-09-20 preseason snap shot: gone 9 frames, found 6.7 ft deep, 7 ft off centre
    const frames = [frame([72, 25]), frame([72.1, 26]), ...Array(9).fill(frame(null)), frame([95.7, 7.1]), frame([93.5, 3.5])]
    expect(goalFrame(frames, true)).toBe(11)
  })

  it('falls back to the closest approach when the puck is never in the net', () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame([70 + i, 12]))
    expect(goalFrame(frames, true)).toBe(9)
  })
})

describe('compactReplay', () => {
  it('keeps positions in feet, a player table, and drops everything else', () => {
    const frames = [
      frame([10, 0], [[12052, 8481611, 52, 'CAR', 5, 1]]),
      frame([12, 0], [[12052, 8481611, 52, 'CAR', 6, 1], [13003, 8477000, 3, 'FLA', 20, -4]]),
    ]
    const c = compactReplay(frames)
    expect(c.hz).toBe(10)
    expect(c.players).toEqual({
      12052: { playerId: 8481611, number: 52, team: 'CAR' },
      13003: { playerId: 8477000, number: 3, team: 'FLA' },
    })
    expect(c.frames[1]).toEqual({ puck: [12, 0], at: { 12052: [6, 1], 13003: [20, -4] } })
  })
})

// ── Route ─────────────────────────────────────────────────────────────

const GAME = '2026010010'
const REPLAY_URL = `https://wsr.nhle.com/sprites/20262027/${GAME}/ev191.json`
const landing = (gameState = 'FINAL', pptReplayUrl = REPLAY_URL) => ({
  id: Number(GAME), gameState,
  homeTeam: { abbrev: 'FLA' }, awayTeam: { abbrev: 'CAR' },
  summary: { scoring: [{ periodDescriptor: { number: 1 }, goals: [{ eventId: 191, playerId: 8484781, pptReplayUrl }] }] },
})

let env
const call = (path) => handleGoalReplay(new Request(`https://w.test${path}`), env, new URL(`https://w.test${path}`))

function mockUpstream({ land = landing(), replayStatus = 200, frames = rushRight() } = {}) {
  globalThis.fetch = vi.fn(async (url, opts) => {
    if (String(url).includes('/landing')) return new Response(JSON.stringify(land), { status: 200 })
    if (String(url).startsWith('https://wsr.nhle.com/')) {
      mockUpstream.replayHeaders = opts?.headers
      return new Response(replayStatus === 200 ? JSON.stringify(frames) : 'Forbidden', { status: replayStatus })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
}

describe('GET /nhl/goal-replay/:gameId/:eventId', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    env = { CACHE: makeFakeCache() }
    env.CACHE.put = vi.fn(env.CACHE.put)
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('rejects anything but numeric ids', async () => {
    mockUpstream()
    expect((await call('/nhl/goal-replay/abc/191')).status).toBe(400)
    expect((await call('/nhl/goal-replay/2026010010/191x')).status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('serves the compact replay, fetched with a browser User-Agent, cached a year once final', async () => {
    mockUpstream()
    const res = await call(`/nhl/goal-replay/${GAME}/191`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ available: true, gameId: 2026010010, eventId: 191, scorerId: 8484781, goalFrame: 20, attacksRight: true, teams: { home: 'FLA', away: 'CAR' } })
    expect(mockUpstream.replayHeaders['User-Agent']).toMatch(/^Mozilla/)
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_FINAL })
  })

  it('caches a live game\'s replay briefly, since it can be rewritten at the final horn', async () => {
    mockUpstream({ land: landing('LIVE') })
    await call(`/nhl/goal-replay/${GAME}/191`)
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_LIVE })
  })

  it('404s (cached a minute) when the replay is not published yet', async () => {
    mockUpstream({ land: landing('LIVE', null) })
    const res = await call(`/nhl/goal-replay/${GAME}/191`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ available: false, gameId: 2026010010, eventId: 191 })
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_MISSING })
    // second call is served from the negative cache
    globalThis.fetch.mockClear()
    expect((await call(`/nhl/goal-replay/${GAME}/191`)).status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('404s when the replay host refuses, and for an unknown goal', async () => {
    mockUpstream({ replayStatus: 403 })
    expect((await call(`/nhl/goal-replay/${GAME}/191`)).status).toBe(404)
    mockUpstream()
    expect((await call(`/nhl/goal-replay/${GAME}/999`)).status).toBe(404)
  })

  it('never fetches a replay URL off the NHL replay host', async () => {
    mockUpstream({ land: landing('FINAL', 'https://evil.example/ev191.json') })
    expect((await call(`/nhl/goal-replay/${GAME}/191`)).status).toBe(404)
    expect(globalThis.fetch.mock.calls.map(c => String(c[0])).some(u => u.includes('evil'))).toBe(false)
  })

  it('502s when the NHL is down', async () => {
    globalThis.fetch = vi.fn(async () => new Response('oops', { status: 503 }))
    expect((await call(`/nhl/goal-replay/${GAME}/191`)).status).toBe(502)
  })

  it('is reachable through handleNHL', async () => {
    mockUpstream()
    const { handleNHL } = await import('../nhl.js')
    const url = new URL(`https://w.test/nhl/goal-replay/${GAME}/191`)
    const res = await handleNHL(new Request(url), env, { waitUntil() {} }, url)
    expect(res.status).toBe(200)
  })
})
