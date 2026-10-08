// src/__tests__/summary-cache-by-state.test.js
// /pwhl/summary and /{ahl,echl}/summary (HockeyTech's gameSummary) were
// cached 1 h (KV and max-age) whatever the game's state, so the app's
// per-period re-read during a live game kept getting the copy from the
// first period (audit 2026-10-06 W14). Now: 60 s under `:live` until
// game_log + scorebar (the /live routes' detection) say final, then 1 h
// under `:final`, so a mid-game copy is never served for a final.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

import { handlePWHL } from '../pwhl.js'
import { handleAHL } from '../ahl.js'
import { handleECHL } from '../echl.js'

const GAME_ID = 1028992

// game_status_code: 2 = in progress, 4 = final (deriveGameStatus).
const gameRow = (code) => ({
  game_id: GAME_ID, home_team_id: 1, away_team_id: 2, home_score: 2, away_score: 1,
  game_state: code === 4 ? 'Final' : 'In Progress', game_status_code: code,
})

const summaryPayload = (venue) => ({
  details: { venue, final: '0', status: '2nd Period' },
  periods: [{ info: { id: '1', shortName: '1', longName: '1st' }, stats: { homeGoals: '1', homeShots: '10', visitingGoals: '0', visitingShots: '8' }, goals: [] }],
  mostValuablePlayers: [],
  homeTeam: { stats: { shots: 10 } },
  visitingTeam: { stats: { shots: 8 } },
})

// game_log answers `rows`; the scorebar is down (game_log is used as-is);
// gameSummary answers `venue` so a test can tell a fresh copy from a
// cached one.
function installUpstream({ rows, venue = 'Fresh Arena' }) {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('_game_log?')) return { ok: true, status: 200, json: async () => rows }
    if (u.includes('view=gameSummary')) return { ok: true, status: 200, text: async () => `(${JSON.stringify(summaryPayload(venue))})` }
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' }
  })
}

const summaryCalls = () => globalThis.fetch.mock.calls.filter(([u]) => String(u).includes('view=gameSummary')).length

// A KV fake that records each put's TTL.
function recordingCache(initial = {}) {
  const cache = makeFakeCache(initial)
  const puts = []
  const put = cache.put.bind(cache)
  cache.put = async (key, value, opts) => {
    puts.push({ key, ttl: opts?.expirationTtl })
    return put(key, value, opts)
  }
  return { cache, puts }
}

const LEAGUES = [
  { name: 'pwhl', handle: handlePWHL, path: '/pwhl/summary', prefix: 'pwhl' },
  { name: 'ahl',  handle: handleAHL,  path: '/ahl/summary',  prefix: 'ahl' },
  { name: 'echl', handle: handleECHL, path: '/echl/summary', prefix: 'echl' },
]

describe.each(LEAGUES)('GET $path caches by game state', ({ handle, path, prefix }) => {
  const realFetch = globalThis.fetch
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

  const key = `${prefix}:gamesummary:${GAME_ID}`
  const call = (cache) => {
    const p = `${path}?gameId=${GAME_ID}`
    return handle(makeRequest(p), makeEnv({ CACHE: cache }), makeCtx(), new URL(`https://example.com${p}`))
  }

  it('a live game: 60 s in KV under :live, max-age=60', async () => {
    installUpstream({ rows: [gameRow(2)] })
    const { cache, puts } = recordingCache()
    const res = await call(cache)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(puts).toEqual([{ key: `${key}:live`, ttl: 60 }])
  })

  it('a final game: 1 h in KV under :final, max-age=3600', async () => {
    installUpstream({ rows: [gameRow(4)] })
    const { cache, puts } = recordingCache()
    const res = await call(cache)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(puts).toEqual([{ key: `${key}:final`, ttl: 3600 }])
  })

  it('a game game_log does not know yet is treated as live', async () => {
    installUpstream({ rows: [] })
    const { cache, puts } = recordingCache()
    const res = await call(cache)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(puts).toEqual([{ key: `${key}:live`, ttl: 60 }])
  })

  it('serves the cached live copy while the game is still live', async () => {
    installUpstream({ rows: [gameRow(2)] })
    const { cache } = recordingCache({ [`${key}:live`]: { venue: 'Cached Arena' } })
    const res = await call(cache)
    expect((await res.json()).venue).toBe('Cached Arena')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(summaryCalls()).toBe(0)
  })

  it('never serves a copy cached mid-game once the game is final', async () => {
    installUpstream({ rows: [gameRow(4)] })
    const { cache, puts } = recordingCache({ [`${key}:live`]: { venue: 'Cached Arena' } })
    const res = await call(cache)
    expect((await res.json()).venue).toBe('Fresh Arena')
    expect(summaryCalls()).toBe(1)
    expect(puts).toEqual([{ key: `${key}:final`, ttl: 3600 }])
  })

  it('a cached final copy is served without reading game_log or HockeyTech', async () => {
    installUpstream({ rows: [gameRow(4)] })
    const { cache } = recordingCache({ [`${key}:final`]: { venue: 'Cached Arena' } })
    const res = await call(cache)
    expect((await res.json()).venue).toBe('Cached Arena')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
