// src/__tests__/nhl-routes.test.js
// Route-level tests for handleNHL's routes (Session 47 + Session 48, Item
// 2 — audit #9). None of these had any HTTP-level coverage before Session
// 47. Session 47 covered a representative slice of the read-proxy tier:
// - /health and /cache/:key (simplest reads, no upstream fetch)
// - /player-analytics (Session 44's Direct-Supabase-read proxy shape --
//   cache hit, happy path, upstream 502)
// - /player-shots (query-param validation: 400 on missing required param)
// - /push/subscribe and /push/unsubscribe (mutating, higher audit
//   priority than reads -- assert the actual KV write, not just a 200)
//
// Session 48 adds the remaining two tiers per the corrected Session 48
// scope (see SESSION_48_DECISIONS.md): Tier 2 (POLL_SECRET-gated
// mutating/ingest routes -- assert actual KV mutations/merge logic, not
// just status codes) and Tier 3 (AI-calling routes). The other ~35
// read-proxy routes still follow the exact same shape as
// /player-analytics/-shots and remain mechanical to extend if ever needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, flushWaitUntil, makeFakeCache, mockFetchWithAI, aiCalls, aiPrompt } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
}))

// sendPush does real VAPID JWT signing + RFC8291 payload encryption via
// crypto.subtle -- mocked here so poll()'s dual-broadcast tests can assert
// on *who* got notified without needing real EC key material. Everything
// else in shared.js (kvGet/kvPut against the test env's CACHE mock, etc.)
// stays real. vi.mock factories are hoisted above regular declarations, so
// the mock fn itself must be created via vi.hoisted() to be visible here.
const { sendPushMock, sendLiveActivityPushMock } = vi.hoisted(() => ({
  sendPushMock: vi.fn().mockResolvedValue('ok'),
  sendLiveActivityPushMock: vi.fn().mockResolvedValue('ok'),
}))
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock, sendLiveActivityPush: sendLiveActivityPushMock }
})

import { handleNHL, poll, refreshPPUnits, oppGoalBody, periodIsOver, scoreboardBroadcasts, liveActivityState, startLiveActivities, applyScoreboardStates, scoreboardStates } from '../nhl.js'
import { resolveNHLSeason } from '../seasons.js'
import * as game2025021237 from './fixtures/nhl-2025021237-penalties.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('GET /health', () => {
  it('reports subscriber count and live game id from KV, defaulting when both are cold', async () => {
    const env = makeEnv()
    const res = await handleNHL(makeRequest('/health'), env, makeCtx(), new URL('https://example.com/health'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, liveGameId: null, subscribers: 0 })
  })

  it('reflects real KV state when populated', async () => {
    const env = makeEnv({
      CACHE: {
        async get(key) {
          if (key === 'live:gameId') return JSON.stringify(2025030415)
          if (key === 'push:subs') return JSON.stringify([{ endpoint: 'a' }, { endpoint: 'b' }])
          return null
        },
        async put() {},
      },
    })

    const res = await handleNHL(makeRequest('/health'), env, makeCtx(), new URL('https://example.com/health'))
    const body = await res.json()

    expect(body.liveGameId).toBe(2025030415)
    expect(body.subscribers).toBe(2)
  })
})

describe('GET /nhl/today', () => {
  // NHL's own /score/now is not "today" -- in the offseason it serves
  // whatever date it considers current (2026-09-15: Sept 29's opener,
  // skipping the Sept 19 preseason games). The route asks for a date.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-15T23:30:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  const scoreFor = (date, games) => vi.fn().mockImplementation((url) => {
    const u = String(url)
    if (u.includes(`/score/${date}`)) return Promise.resolve({ ok: true, json: async () => ({ games }) })
    return Promise.resolve({ ok: true, json: async () => ({ games: [] }) })
  })
  const today = (env = makeEnv()) =>
    handleNHL(makeRequest('/nhl/today'), env, makeCtx(), new URL('https://example.com/nhl/today'))

  it("asks for today's Eastern date and normalizes into the shared pre/live/final shape", async () => {
    globalThis.fetch = scoreFor('2026-01-15', [
      { id: 2025020100, gameDate: '2026-01-15', startTimeUTC: '2026-01-16T00:00:00Z', gameType: 2, gameState: 'FUT', homeTeam: { abbrev: 'CAR', score: 0 }, awayTeam: { abbrev: 'BOS', score: 0 } },
      { id: 2025020101, gameDate: '2026-01-15', gameType: 2, gameState: 'LIVE', homeTeam: { abbrev: 'TOR', score: 2 }, awayTeam: { abbrev: 'MTL', score: 1 },
        periodDescriptor: { number: 2, periodType: 'REG' }, clock: { timeRemaining: '12:34', inIntermission: false } },
      { id: 2025020102, gameDate: '2026-01-15', gameType: 2, gameState: 'FINAL', homeTeam: { abbrev: 'NYR', score: 4 }, awayTeam: { abbrev: 'NJD', score: 3 },
        gameOutcome: { lastPeriodType: 'OT' } },
    ])

    const res = await today()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/score/2026-01-15')
    expect(body.map(g => g.status)).toEqual(['pre', 'live', 'final'])
    expect(body.every(g => g.gameDate === '2026-01-15')).toBe(true)
    expect(body[0]).toMatchObject({ gameId: 2025020100, homeTeamCode: 'CAR', awayTeamCode: 'BOS', startTimeUTC: '2026-01-16T00:00:00Z', gameType: 2, period: null, clock: null })
    expect(body[1]).toMatchObject({ period: 2, periodType: 'REG', clock: '12:34', inIntermission: false })
    expect(body[2]).toMatchObject({ homeScore: 4, awayScore: 3, endedIn: 'OT' })
  })

  it('reports an intermission rather than a running clock', async () => {
    globalThis.fetch = scoreFor('2026-01-15', [
      { id: 1, gameDate: '2026-01-15', gameState: 'LIVE', homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'BOS' },
        periodDescriptor: { number: 1, periodType: 'REG' }, clock: { timeRemaining: '18:00', inIntermission: true } },
    ])
    const body = await (await today()).json()
    expect(body[0]).toMatchObject({ status: 'live', period: 1, inIntermission: true })
  })

  it('a regulation final carries no endedIn marker', async () => {
    globalThis.fetch = scoreFor('2026-01-15', [
      { id: 1, gameDate: '2026-01-15', gameState: 'OFF', homeTeam: { abbrev: 'CAR', score: 3 }, awayTeam: { abbrev: 'BOS', score: 1 }, gameOutcome: { lastPeriodType: 'REG' } },
    ])
    expect((await (await today()).json())[0].endedIn).toBeNull()
  })

  it('walks forward to the next date with games when today has none', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('/score/2026-01-15')) return Promise.resolve({ ok: true, json: async () => ({ games: [] }) })
      if (u.includes('/schedule/2026-01-15')) {
        return Promise.resolve({ ok: true, json: async () => ({ gameWeek: [
          { date: '2026-01-15', numberOfGames: 0 },
          { date: '2026-01-17', numberOfGames: 2 },
        ] }) })
      }
      if (u.includes('/score/2026-01-17')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [
          { id: 7, gameDate: '2026-01-17', gameType: 1, gameState: 'FUT', homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'BOS' } },
        ] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    const body = await (await today()).json()

    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ gameId: 7, gameDate: '2026-01-17', gameType: 1, status: 'pre' })
  })

  it('returns an empty list rather than erroring when the lookahead itself fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => String(url).includes('/schedule/')
      ? Promise.reject(new Error('schedule down'))
      : Promise.resolve({ ok: true, json: async () => ({ games: [] }) }))
    const res = await today()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('serves from KV on a warm cache without re-fetching upstream', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock
    const env = makeEnv({
      CACHE: makeFakeCache({ 'nhl:today': [{ gameId: 1, homeTeamCode: 'CAR', awayTeamCode: 'BOS', homeScore: 1, awayScore: 0, status: 'live' }] }),
    })

    const res = await handleNHL(makeRequest('/nhl/today'), env, makeCtx(), new URL('https://example.com/nhl/today'))

    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body[0].status).toBe('live')
  })
})

describe('GET /cache/:key', () => {
  it('returns 404 for a cold, non-schedule key (no background fetch to trigger)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/cache/nhl:player-analytics:20252026'),
      env, makeCtx(),
      new URL('https://example.com/cache/nhl:player-analytics:20252026')
    )
    expect(res.status).toBe(404)
  })

  it('returns the cached value on a hit', async () => {
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify({ hello: 'world' }) }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/cache/some:key'), env, makeCtx(), new URL('https://example.com/cache/some:key')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: 'world' })
  })
})

// ── Season-aware /schedule (Session 77 — shot map history selector) ──
// Key shape moved from `schedule:{abbr}` to `schedule:{abbr}:{season}` so
// multiple seasons can be cached side by side. Current season keeps the
// short (10 min) TTL; any other explicitly-requested season is treated as
// historical/immutable and gets a long TTL instead.
describe('GET /schedule', () => {
  it('cold cache, no ?season=: background-fetches the current season and caches it under the season-namespaced key with the short TTL', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 1 }] }) })
    const ctx = makeCtx()

    const res = await handleNHL(makeRequest('/schedule'), env, ctx, new URL('https://example.com/schedule'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    await flushWaitUntil(ctx)

    expect(putSpy).toHaveBeenCalledWith('schedule:CAR:20252026', JSON.stringify([{ id: 1 }]), { expirationTtl: 600 })
  })

  it('cold cache, explicit historical ?season=: fetches and returns that season SYNCHRONOUSLY (no background/retry-later gap), caching it with the long TTL', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 99 }] }) })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/schedule?season=20232024'), env, ctx,
      new URL('https://example.com/schedule?season=20232024')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: 99 }]) // real data immediately, not []
    expect(ctx._promises.length).toBe(0) // no ctx.waitUntil — this path doesn't defer

    expect(putSpy).toHaveBeenCalledWith('schedule:CAR:20232024', JSON.stringify([{ id: 99 }]), { expirationTtl: 60 * 24 * 3600 })
  })

  it('warm cache for a specific historical season: serves directly from KV, no background fetch triggered', async () => {
    const cachedGames = [{ id: 5 }]
    const env = makeEnv({
      CACHE: { async get(key) { return key === 'schedule:CAR:20232024' ? JSON.stringify(cachedGames) : null }, async put() {} },
    })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/schedule?season=20232024'), env, ctx,
      new URL('https://example.com/schedule?season=20232024')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedGames)
    expect(ctx._promises.length).toBe(0)
  })

  // Regression (2026-09-27): the next season, asked for before the Worker
  // flips to it, was cached as "historical" for 60 days -- VGK/CHI's
  // 2026-27 preseason games stayed FUT long after they'd been played.
  it('cold cache, the NEXT season (not yet current here): short TTL, not the 60-day historical one', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 7 }] }) })
    const ctx = makeCtx()

    await handleNHL(
      makeRequest('/schedule?season=20262027'), env, ctx,
      new URL('https://example.com/schedule?season=20262027')
    )
    await flushWaitUntil(ctx)

    expect(putSpy).toHaveBeenCalledWith('schedule:CAR:20262027', JSON.stringify([{ id: 7 }]), { expirationTtl: 600 })
  })
})

describe('GET /cache/schedule:* (cache miss)', () => {
  const missEnv = putSpy => makeEnv({
    CACHE: {
      async get(key) { return key === 'config:season:nhl' ? JSON.stringify({ seasonId: '20252026' }) : null },
      put: putSpy,
    },
  })

  it('background-fetches the next season with the short TTL', async () => {
    const putSpy = vi.fn()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 8 }] }) })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/cache/schedule:VGK:20262027'), missEnv(putSpy), ctx,
      new URL('https://example.com/cache/schedule:VGK:20262027')
    )
    expect(res.status).toBe(404)
    await flushWaitUntil(ctx)

    expect(putSpy).toHaveBeenCalledWith('schedule:VGK:20262027', JSON.stringify([{ id: 8 }]), { expirationTtl: 600 })
  })

  it('still gives a past season the long TTL', async () => {
    const putSpy = vi.fn()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ games: [{ id: 9 }] }) })
    const ctx = makeCtx()

    await handleNHL(
      makeRequest('/cache/schedule:VGK:20242025'), missEnv(putSpy), ctx,
      new URL('https://example.com/cache/schedule:VGK:20242025')
    )
    await flushWaitUntil(ctx)

    expect(putSpy).toHaveBeenCalledWith('schedule:VGK:20242025', JSON.stringify([{ id: 9 }]), { expirationTtl: 60 * 24 * 3600 })
  })
})

// ── /roster (added alongside this session's roster-caching fix) ──
// getRoster() (eyewallanalytics) used to call NHL's /roster/{team}/current
// directly with zero server-side caching, unlike /schedule and /standings
// above -- every request was a genuinely fresh live upstream call, which
// was the root cause of repeated Cypress flakiness (4 teams' worth of
// live fetches every CI run, nothing to fall back on but the real API's
// response time). Fully synchronous fetch-and-cache-on-miss, same shape
// as /schedule's historical-season branch above -- this is a foreground
// page (Players view Roster tab), not a background feed, so a cold-miss
// user needs real data now, not an empty response with a silent retry.
describe('GET /roster', () => {
  it('cold cache: fetches from NHL, caches under roster:{abbr} with the 1hr TTL, returns real data', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    const rosterPayload = { forwards: [{ id: 1, sweaterNumber: 20 }], defensemen: [], goalies: [] }
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => rosterPayload })

    const res = await handleNHL(makeRequest('/roster'), env, makeCtx(), new URL('https://example.com/roster'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rosterPayload)
    expect(putSpy).toHaveBeenCalledWith('roster:CAR', JSON.stringify(rosterPayload), { expirationTtl: 3600 })
  })

  it('warm cache: serves directly from KV, no upstream fetch', async () => {
    const cachedRoster = { forwards: [{ id: 2 }], defensemen: [], goalies: [] }
    const env = makeEnv({
      CACHE: { async get(key) { return key === 'roster:CAR' ? JSON.stringify(cachedRoster) : null }, async put() {} },
    })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/roster'), env, makeCtx(), new URL('https://example.com/roster'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRoster)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('respects ?team=, keying the cache per team', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ forwards: [], defensemen: [], goalies: [] }) })

    await handleNHL(makeRequest('/roster?team=TOR'), env, makeCtx(), new URL('https://example.com/roster?team=TOR'))

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/roster/TOR/current'),
      expect.anything()
    )
    expect(putSpy).toHaveBeenCalledWith('roster:TOR', expect.any(String), { expirationTtl: 3600 })
  })

  it('upstream failure: returns an empty roster shape instead of a 500, does not cache the failure', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 })

    const res = await handleNHL(makeRequest('/roster'), env, makeCtx(), new URL('https://example.com/roster'))

    expect(res.status).toBe(200) // degrades gracefully, not a 500
    expect(await res.json()).toEqual({ forwards: [], defensemen: [], goalies: [] })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /injuries (added alongside injuries.py / player_injuries) ──
// Same KV-cache-then-Supabase-read shape as /team-lines above; not
// season-scoped, unlike that route -- injuries aren't a per-season
// concept, this table is always just "current league-wide state."
describe('GET /injuries', () => {
  it('cold cache: reads player_injuries scoped to ?team=, caches under injuries:{abbr} with 1hr TTL', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    const injuryRows = [
      {
        player_id: 8480762, player_name: 'Eric Robinson', status: 'day-to-day', comment: 'day-to-day', espn_updated_at: '2026-09-10T14:06Z',
        injury_type: 'Knee', injury_side: 'Left', injury_detail: 'Surgery', return_date: '2026-09-20',
      },
    ]
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => injuryRows })

    const res = await handleNHL(makeRequest('/injuries?team=CAR'), env, makeCtx(), new URL('https://example.com/injuries?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(injuryRows)
    const calledUrl = globalThis.fetch.mock.calls[0][0]
    expect(calledUrl).toContain('player_injuries')
    expect(calledUrl).toContain('team=eq.CAR')
    for (const col of ['injury_type', 'injury_side', 'injury_detail', 'return_date']) {
      expect(calledUrl).toContain(col)
    }
    expect(putSpy).toHaveBeenCalledWith('nhl:injuries:CAR', JSON.stringify(injuryRows), { expirationTtl: 3600 })
  })

  it('warm cache: serves directly from KV, no Supabase read', async () => {
    const cachedRows = [{ player_id: 1, player_name: 'Test Player', status: 'out' }]
    const env = makeEnv({
      CACHE: { async get(key) { return key === 'nhl:injuries:CAR' ? JSON.stringify(cachedRows) : null }, async put() {} },
    })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/injuries?team=CAR'), env, makeCtx(), new URL('https://example.com/injuries?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('defaults to DEFAULT_TEAM_ABBR when ?team= is omitted', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    await handleNHL(makeRequest('/injuries'), env, makeCtx(), new URL('https://example.com/injuries'))

    expect(globalThis.fetch.mock.calls[0][0]).toContain('team=eq.CAR')
  })

  it('degrades to an empty array (not a 502) on a Supabase read failure, matching /team-lines', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(makeRequest('/injuries?team=CAR'), env, makeCtx(), new URL('https://example.com/injuries?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

// ── /transactions (added alongside eyewall-pipeline's transactions.py) ──
// Pairing itself is unit-tested in transactions.test.js; these cover the
// route: the Supabase query shape per scope, the KV key/TTL, the paired
// response, input validation, and not caching a failed read.
describe('GET /transactions', () => {
  const tradeRows = [
    { id: 1, tx_date: '2026-06-27', team: 'CAR', categories: ['trade'], primary_category: 'trade', counterparties: ['ANA'],
      description: 'Acquired D John Carlson from Anaheim in exchange for D Kyle Masters and a 2026 sixth-round pick (No. 162).' },
    { id: 2, tx_date: '2026-06-27', team: 'ANA', categories: ['trade'], primary_category: 'trade', counterparties: ['CAR'],
      description: 'Acquired D Kyle Masters and a 2026 sixth-round pick (No. 162) from Carolina Hurricanes for D John Carlson.' },
  ]

  it('team scope: filters to the team or trades naming it, pairs halves, caches under the team key for 1hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => tradeRows })

    const res = await handleNHL(makeRequest('/transactions?team=ANA'), env, makeCtx(), new URL('https://example.com/transactions?team=ANA'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scope).toBe('team')
    expect(body.team).toBe('ANA')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].kind).toBe('trade')
    expect(body.items[0].teams).toEqual(['ANA', 'CAR']) // focus team first
    const calledUrl = globalThis.fetch.mock.calls[0][0]
    expect(calledUrl).toContain('nhl_transactions')
    expect(calledUrl).toContain('or=(team.eq.ANA,counterparties.cs.%7BANA%7D)')
    expect(calledUrl).toContain('order=tx_date.desc,id.desc')
    expect(putSpy).toHaveBeenCalledWith('nhl:transactions:team:ANA', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('league scope: no team filter, league cache key', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => tradeRows })

    const res = await handleNHL(makeRequest('/transactions?scope=league'), env, makeCtx(), new URL('https://example.com/transactions?scope=league'))

    const body = await res.json()
    expect(body).toMatchObject({ scope: 'league', team: null })
    expect(globalThis.fetch.mock.calls[0][0]).not.toContain('or=')
    expect(putSpy.mock.calls[0][0]).toBe('nhl:transactions:league')
  })

  it('warm cache: serves directly from KV, no Supabase read', async () => {
    const cachedBody = { scope: 'team', team: 'CAR', items: [] }
    const env = makeEnv({
      CACHE: { async get(key) { return key === 'nhl:transactions:team:CAR' ? JSON.stringify(cachedBody) : null }, async put() {} },
    })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/transactions?team=CAR'), env, makeCtx(), new URL('https://example.com/transactions?team=CAR'))

    expect(await res.json()).toEqual(cachedBody)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects a team value that is not a 2-3 letter abbreviation (it lands in a PostgREST filter)', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/transactions?team=CAR),id.gt.0'), env, makeCtx(), new URL('https://example.com/transactions?team=CAR),id.gt.0'))

    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('degrades to empty items on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(makeRequest('/transactions?team=CAR'), env, makeCtx(), new URL('https://example.com/transactions?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scope: 'team', team: 'CAR', items: [] })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /trades/tree (added alongside eyewall-pipeline's trade_trees.py) ──
// The walk itself is unit-tested in trades.test.js; these cover the route:
// validation, the KV key/TTL, and not caching a not-found or a failed read.
describe('GET /trades/tree', () => {
  const ROOT = 'aaaaaaaaaaaaaaaa'
  const get = (tx, env) => handleNHL(makeRequest(`/trades/tree?tx=${tx}`), env, makeCtx(), new URL(`https://example.com/trades/tree?tx=${tx}`))
  const respond = rows => ({ ok: true, json: async () => rows })

  it('finds the trade holding the transaction, returns its tree, caches 1hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('source_tx_ids=cs.%7B1%7D')) {
        return respond([{ trade_id: ROOT, tx_date: '2026-06-27', teams: ['ANA', 'CAR'], via: [], descriptions: ['x'] }])
      }
      if (url.includes('trade_assets') && url.includes(`trade_id=in.(${ROOT})`)) {
        return respond([{ trade_id: ROOT, idx: 0, from_team: 'ANA', to_team: 'CAR', asset_type: 'player', player_name: 'John Carlson' }])
      }
      return respond([])
    })

    const res = await get('1', env)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ found: true, root: ROOT, origins: [], truncated: false })
    expect(body.trades[ROOT].sides.find(s => s.team === 'CAR').received[0].name).toBe('John Carlson')
    expect(putSpy).toHaveBeenCalledWith('nhl:trades:tree:1', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('rejects a tx that is not digits (it lands in a PostgREST filter)', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()
    const res = await get('1%7D),id.gt.(0', env)
    expect(res.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('does not cache a not-found', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue(respond([]))
    const body = await (await get('99', env)).json()
    expect(body).toEqual({ found: false, root: null, trades: {}, origins: [], truncated: false })
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('flags a Supabase failure as unavailable and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    const body = await (await get('1', env)).json()
    expect(body).toMatchObject({ found: false, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /scratches (added alongside eyewall-pipeline's scratches.py) ──
// Summary math is unit-tested in scratches.test.js; these cover the route:
// query shape, validation, prior-season fallback, KV key, no-cache-on-failure.
// resolveNHLSeason is mocked to 20252026 at the top of this file.
describe('GET /scratches', () => {
  const rows = [
    { game_id: 1, game_date: '2025-12-13', player_id: 8476422, player_name: 'Mike Reilly', scratch_type: 'unknown' },
    { game_id: 2, game_date: '2025-12-15', player_id: 8476422, player_name: 'Mike Reilly', scratch_type: 'unknown' },
  ]

  it('cold cache: queries the live season regular-season rows and summarizes them', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => rows })

    const res = await handleNHL(makeRequest('/scratches?team=CAR'), env, makeCtx(), new URL('https://example.com/scratches?team=CAR'))

    const body = await res.json()
    expect(body).toMatchObject({ team: 'CAR', season: 20252026, gameType: 2, stale: false, classified: false })
    expect(body.players[0]).toMatchObject({ player_name: 'Mike Reilly', total: 2, unknown: 2 })
    const calledUrl = globalThis.fetch.mock.calls[0][0]
    expect(calledUrl).toContain('game_scratches?team=eq.CAR&season=eq.20252026&game_type=eq.2')
    expect(putSpy).toHaveBeenCalledWith('nhl:scratches:CAR:auto:2', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('falls back to the prior season when the live one has no rows yet, and flags it stale', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => rows })

    const res = await handleNHL(makeRequest('/scratches?team=CAR'), env, makeCtx(), new URL('https://example.com/scratches?team=CAR'))

    const body = await res.json()
    expect(body).toMatchObject({ season: 20242025, stale: true })
    expect(globalThis.fetch.mock.calls[1][0]).toContain('season=eq.20242025')
  })

  it('does not fall back when a season is given explicitly', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(makeRequest('/scratches?team=CAR&season=20262027&gameType=3'), env, makeCtx(), new URL('https://example.com/scratches?team=CAR&season=20262027&gameType=3'))

    expect(await res.json()).toMatchObject({ season: 20262027, gameType: 3, stale: false, players: [] })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch.mock.calls[0][0]).toContain('game_type=eq.3')
  })

  it('rejects an invalid team, season, or gameType before querying', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()
    for (const qs of ['team=CAR),id.gt.0', 'team=CAR&season=2025', 'team=CAR&gameType=1']) {
      const res = await handleNHL(makeRequest(`/scratches?${qs}`), env, makeCtx(), new URL(`https://example.com/scratches?${qs}`))
      expect(res.status).toBe(400)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('degrades to an empty summary on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(makeRequest('/scratches?team=CAR'), env, makeCtx(), new URL('https://example.com/scratches?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ team: 'CAR', players: [], stale: false })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /draft/pick-history (added alongside eyewall-pipeline's draft_history.py) ──
// Two parallel reads of draft_pick_history: picks the team made, and its own
// original picks another team used. Fixture rows are real 2025-26 CAR picks.
describe('GET /draft/pick-history', () => {
  const sinceYear = new Date().getUTCFullYear() - 4
  const made = [
    { draft_year: 2026, round: 2, overall_pick: 51, team: 'CAR', original_team: 'UTA', pick_chain: ['UTA', 'CGY', 'CAR'], times_traded: 2, player_name: 'William Hakansson', position: 'D' },
  ]
  const away = [
    { draft_year: 2025, round: 1, overall_pick: 29, team: 'CHI', original_team: 'CAR', pick_chain: ['CAR', 'CHI'], times_traded: 1, player_name: 'Mason West', position: 'C' },
  ]
  const byUrl = () => vi.fn().mockImplementation(async (u) => ({ ok: true, json: async () => (u.includes('original_team=eq.') ? away : made) }))

  it('queries picks made and own picks traded away for the last 5 drafts, caches 6hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = byUrl()

    const res = await handleNHL(makeRequest('/draft/pick-history?team=CAR'), env, makeCtx(), new URL('https://example.com/draft/pick-history?team=CAR'))

    const body = await res.json()
    expect(body).toEqual({ team: 'CAR', sinceYear, made, tradedAway: away })
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls).toHaveLength(2)
    expect(urls.every(u => u.includes('draft_pick_history') && u.includes(`draft_year=gte.${sinceYear}`))).toBe(true)
    // Both queries SELECT the original_team column, so match the filter, not the column name.
    expect(urls.some(u => u.includes('&team=eq.CAR') && !u.includes('original_team=eq.'))).toBe(true)
    expect(urls.some(u => u.includes('original_team=eq.CAR') && u.includes('team=neq.CAR'))).toBe(true)
    expect(putSpy).toHaveBeenCalledWith(`draft:pick-history:CAR:${sinceYear}`, JSON.stringify(body), { expirationTtl: 6 * 3600 })
  })

  it('warm cache: serves directly from KV, no Supabase read', async () => {
    const cachedBody = { team: 'CAR', sinceYear, made: [], tradedAway: [] }
    const env = makeEnv({
      CACHE: { async get(key) { return key === `draft:pick-history:CAR:${sinceYear}` ? JSON.stringify(cachedBody) : null }, async put() {} },
    })
    globalThis.fetch = vi.fn()

    const res = await handleNHL(makeRequest('/draft/pick-history?team=CAR'), env, makeCtx(), new URL('https://example.com/draft/pick-history?team=CAR'))

    expect(await res.json()).toEqual(cachedBody)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('defaults to DEFAULT_TEAM_ABBR and rejects an invalid team', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = byUrl()
    const res = await handleNHL(makeRequest('/draft/pick-history'), env, makeCtx(), new URL('https://example.com/draft/pick-history'))
    expect((await res.json()).team).toBe('CAR')

    globalThis.fetch = vi.fn()
    const bad = await handleNHL(makeRequest('/draft/pick-history?team=CAR),id.gt.0'), env, makeCtx(), new URL('https://example.com/draft/pick-history?team=CAR),id.gt.0'))
    expect(bad.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('degrades to empty lists on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(makeRequest('/draft/pick-history?team=CAR'), env, makeCtx(), new URL('https://example.com/draft/pick-history?team=CAR'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ team: 'CAR', sinceYear, made: [], tradedAway: [] })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /playoff-odds (added alongside eyewall-pipeline's playoff_odds.py) ──
// Latest row + season history in parallel, then the latest run's
// playoff_odds_game_impacts rows for the next game-day.
describe('GET /playoff-odds', () => {
  const latest = {
    season: 20262027, run_date: '2026-10-15', playoff_pct: 0.641, division_pct: 0.214, proj_points: 95.3,
    points_p10: 87, points_p90: 103, current_points: 4, games_played: 3, games_remaining: 81, elo_rating: 1531.2, sims: 10000,
    change: { prev_run_date: '2026-10-14', prev_pct: 0.58, delta: 0.061, contributions: [], residual: 0.061 },
  }
  const historyDesc = [
    { season: 20262027, run_date: '2026-10-15', playoff_pct: 0.641 },
    { season: 20262027, run_date: '2026-10-14', playoff_pct: 0.58 },
    { season: 20252026, run_date: '2026-04-16', playoff_pct: 1 },
  ]
  const impact = (game_id, home_team, away_team, outcome, playoff_pct) => ({ game_id, game_date: '2026-10-16', home_team, away_team, outcome, playoff_pct })
  const impacts = [
    impact(2026020041, 'NYR', 'BOS', 'home', 0.62), impact(2026020041, 'NYR', 'BOS', 'away', 0.60),
    impact(2026020040, 'CAR', 'OTT', 'home', 0.66), impact(2026020040, 'CAR', 'OTT', 'away', 0.57),
    impact(2026020042, 'MTL', 'TOR', 'home', 0.641), impact(2026020042, 'MTL', 'TOR', 'away', 0.643),
  ]
  const byUrl = ({ latestRows = [latest], impactRows = impacts } = {}) => vi.fn().mockImplementation(async (u) => ({
    ok: true,
    json: async () => (u.includes('playoff_odds_game_impacts') ? impactRows : u.endsWith('limit=1') ? latestRows : historyDesc),
  }))
  const get = (env, qs) => handleNHL(makeRequest(`/playoff-odds${qs}`), env, makeCtx(), new URL(`https://example.com/playoff-odds${qs}`))

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-16T15:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  it("returns the latest run, that season's history, and the next game-day's stakes; caches 1hr", async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = byUrl()

    const body = await (await get(env, '?team=CAR')).json()

    expect(body).toMatchObject({ team: 'CAR', season: 20262027, runDate: '2026-10-15', stale: false, latest })
    expect(body.history).toEqual([{ run_date: '2026-10-14', playoff_pct: 0.58 }, { run_date: '2026-10-15', playoff_pct: 0.641 }])
    expect(body.nextGames.map(g => g.game_id)).toEqual([2026020040, 2026020041])
    expect(body.nextGames[0]).toMatchObject({ home: 'CAR', away: 'OTT', ifHomeWins: 0.66, ifAwayWins: 0.57, own: true })
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls).toHaveLength(3)
    expect(urls.filter(u => u.includes('/playoff_odds?') && u.includes('team=eq.CAR') && !u.includes('season=eq.'))).toHaveLength(2)
    expect(urls.find(u => u.includes('playoff_odds_game_impacts'))).toContain('season=eq.20262027&run_date=eq.2026-10-15&team=eq.CAR')
    expect(putSpy).toHaveBeenCalledWith('nhl:playoff-odds:CAR:latest', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('returns the whole division from the same run, ranked, so the number has context', async () => {
    const standings = [
      { teamAbbrev: { default: 'CAR' }, divisionName: 'Metropolitan' },
      { teamAbbrev: { default: 'NJD' }, divisionName: 'Metropolitan' },
      { teamAbbrev: { default: 'BOS' }, divisionName: 'Atlantic' },
    ]
    const env = makeEnv({ CACHE: makeFakeCache({ standings }) })
    globalThis.fetch = vi.fn().mockImplementation(async (u) => ({
      ok: true,
      json: async () => {
        if (u.includes('playoff_odds_game_impacts')) return impacts
        if (u.includes('team=in.')) {
          return [
            { team: 'CAR', division_pct: 0.214, playoff_pct: 0.641, proj_points: 95.3 },
            { team: 'NJD', division_pct: 0.402, playoff_pct: 0.77, proj_points: 101.1 },
          ]
        }
        return u.endsWith('limit=1') ? [latest] : historyDesc
      },
    }))

    const body = await (await get(env, '?team=CAR')).json()

    expect(body.division).toMatchObject({ name: 'Metropolitan', rank: 2, of: 2 })
    expect(body.division.teams.map(t => t.team)).toEqual(['NJD', 'CAR'])  // ranked by division odds
    expect(body.division.teams[1]).toMatchObject({ team: 'CAR', divisionPct: 0.214, playoffPct: 0.641, projPoints: 95.3 })
    const peerUrl = globalThis.fetch.mock.calls.map(c => c[0]).find(u => u.includes('team=in.'))
    expect(peerUrl).toContain('season=eq.20262027&run_date=eq.2026-10-15')  // same run, not a fresher one
    expect(peerUrl).not.toContain('BOS')  // other divisions aren't fetched
  })

  it('renders without division context when standings are unavailable', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    globalThis.fetch = byUrl()
    const body = await (await get(env, '?team=CAR')).json()
    expect(body.division).toBeNull()
    expect(body.latest).toMatchObject({ division_pct: 0.214 })  // the team's own number still shows
  })

  it('flags a latest run older than a few days as stale', async () => {
    vi.setSystemTime(new Date('2027-08-01T12:00:00Z'))
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = byUrl()
    expect((await (await get(env, '?team=CAR')).json()).stale).toBe(true)
  })

  it('filters by an explicit season, and rejects an invalid team or season', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = byUrl()
    await get(env, '?team=car&season=20262027')
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls.filter(u => u.includes('/playoff_odds?') && u.includes('team=eq.CAR&season=eq.20262027'))).toHaveLength(2)

    globalThis.fetch = vi.fn()
    expect((await get(env, '?team=CAR),id.gt.0')).status).toBe(400)
    expect((await get(env, '?team=CAR&season=2026')).status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('before the first run: empty result, no impacts read, not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = byUrl({ latestRows: [] })

    const body = await (await get(env, '?team=CAR')).json()

    expect(body).toEqual({ team: 'CAR', season: null, runDate: null, stale: false, latest: null, history: [], nextGames: [] })
    expect(globalThis.fetch.mock.calls.some(c => c[0].includes('playoff_odds_game_impacts'))).toBe(false)
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('degrades to unavailable on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await get(env, '?team=CAR')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ team: 'CAR', latest: null, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /injury-impact (added alongside eyewall-pipeline's injury_impact.py) ──
// The team's latest team_injury_impact row, then every team's row that
// season for league averages.
describe('GET /injury-impact', () => {
  const impact = {
    season: 20262027, team: 'CAR', games_played: 10, man_games_lost: 14, war_lost: 0.62, players_injured: 3,
    rank_man_games: 5, rank_war_lost: 3, updated_at: '2026-10-29T12:40:00+00:00',
    players: [{ player_id: 8478427, player_name: 'Sebastian Aho', games: 6, war_lost: 0.41, last_date: '2026-10-28', status: 'out', injury_type: 'Upper Body' }],
  }
  const league = [
    { team: 'CAR', games_played: 10, man_games_lost: 14, war_lost: 0.62 },
    { team: 'OTT', games_played: 9, man_games_lost: 6, war_lost: 0.18 },
  ]
  const byUrl = ({ teamRows = [impact] } = {}) => vi.fn().mockImplementation(async (u) => ({
    ok: true,
    json: async () => (u.includes('limit=1') ? teamRows : league),
  }))
  const get = (env, qs) => handleNHL(makeRequest(`/injury-impact${qs}`), env, makeCtx(), new URL(`https://example.com/injury-impact${qs}`))

  it("returns the team's season row and league averages; caches 1hr", async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = byUrl()

    const body = await (await get(env, '?team=CAR')).json()

    expect(body).toEqual({
      team: 'CAR', season: 20262027, impact,
      league: { teams: 2, avgManGames: 10, avgWarLost: 0.4, avgGamesPlayed: 9.5 },
    })
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('team_injury_impact?')
    expect(urls[0]).toContain('team=eq.CAR&order=season.desc&limit=1')
    expect(urls[1]).toContain('season=eq.20262027')
    expect(urls[1]).not.toContain('team=eq.')
    expect(putSpy).toHaveBeenCalledWith('nhl:injury-impact:CAR:latest', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('filters by an explicit season, and rejects an invalid team or season', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = byUrl()
    await get(env, '?team=car&season=20262027')
    expect(globalThis.fetch.mock.calls[0][0]).toContain('team=eq.CAR&season=eq.20262027')

    globalThis.fetch = vi.fn()
    expect((await get(env, '?team=CAR),id.gt.0')).status).toBe(400)
    expect((await get(env, '?team=CAR&season=2026')).status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('before the first game: impact null, no league read, not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = byUrl({ teamRows: [] })

    const body = await (await get(env, '?team=CAR')).json()

    expect(body).toEqual({ team: 'CAR', season: null, impact: null, league: null })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('degrades to unavailable on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await get(env, '?team=CAR')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ team: 'CAR', impact: null, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /probable-starters (added alongside eyewall-pipeline's starting_goalie.py) ──
// One read of goalie_start_probs for the game, both teams, shaped by
// summarizeStarters().
describe('GET /probable-starters', () => {
  const probs = [
    { team: 'CAR', goalie_id: 8483548, goalie_name: 'Brandon Bussi', start_prob: 0.62, factors: { share_last10: 0.6, started_last: true }, game_date: '2026-09-29', run_date: '2026-09-28' },
    { team: 'CAR', goalie_id: 8480051, goalie_name: 'Cayden Primeau', start_prob: 0.38, factors: { share_last10: 0.4, started_last: false }, game_date: '2026-09-29', run_date: '2026-09-28' },
    { team: 'FLA', goalie_id: 8475683, goalie_name: 'Sergei Bobrovsky', start_prob: 0.81, factors: { share_last10: 0.8 }, game_date: '2026-09-29', run_date: '2026-09-28' },
  ]
  const get = (env, qs) => handleNHL(makeRequest(`/probable-starters${qs}`), env, makeCtx(), new URL(`https://example.com/probable-starters${qs}`))

  it("returns both teams' goalies most likely first; caches 1hr", async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => probs })

    const body = await (await get(env, '?game=2026020001')).json()

    expect(body.gameId).toBe(2026020001)
    expect(body.gameDate).toBe('2026-09-29')
    expect(body.runDate).toBe('2026-09-28')
    expect(body.teams.CAR.map(g => g.goalie_name)).toEqual(['Brandon Bussi', 'Cayden Primeau'])
    expect(body.teams.FLA).toHaveLength(1)
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('goalie_start_probs?')
    expect(urls[0]).toContain('game_id=eq.2026020001')
    expect(putSpy).toHaveBeenCalledWith('nhl:probable-starters:2026020001', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('warm cache: serves directly from KV, no Supabase read', async () => {
    const cachedBody = { gameId: 2026020001, gameDate: '2026-09-29', runDate: '2026-09-28', teams: { CAR: [] } }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'nhl:probable-starters:2026020001' ? JSON.stringify(cachedBody) : null }, async put() {} } })
    globalThis.fetch = vi.fn()
    expect(await (await get(env, '?game=2026020001')).json()).toEqual(cachedBody)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('outside the 2-day window: empty teams, not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    expect(await (await get(env, '?game=2026020001')).json()).toEqual({ gameId: 2026020001, gameDate: null, runDate: null, teams: {} })
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('rejects a missing or malformed game id', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()
    for (const qs of ['', '?game=abc', '?game=2026020001),id.gt.0', '?game=123']) {
      expect((await get(env, qs)).status).toBe(400)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('degrades to unavailable on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await get(env, '?game=2026020001')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ gameId: 2026020001, teams: {}, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /projected-lines (added alongside eyewall-pipeline's projected_lines.py) ──
// One read of projected_lines for the team, shaped by summarizeProjectedLines().
describe('GET /projected-lines', () => {
  const rows = [
    { unit_type: 'D', rank: 1, player_ids: [8476958, 8479402], names: ['Jaccob Slavin', 'Jalen Chatfield'], positions: ['D', 'D'], filled_ids: [8479402], basis: 'preseason', basis_game_id: 2026010042, basis_games: 5, generated_at: '2026-09-28T08:00:00Z' },
    { unit_type: 'F', rank: 1, player_ids: [8478427, 8480039, 8481708], names: ['Sebastian Aho', 'Andrei Svechnikov', 'Seth Jarvis'], positions: ['C', 'L', 'R'], filled_ids: [], basis: 'preseason', basis_game_id: 2026010042, basis_games: 5, generated_at: '2026-09-28T08:00:00Z' },
  ]
  const get = (env, qs) => handleNHL(makeRequest(`/projected-lines${qs}`), env, makeCtx(), new URL(`https://example.com/projected-lines${qs}`))

  it('returns the shaped projection for the team; caches 1hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => rows })

    const body = await (await get(env, '?team=car')).json()

    expect(body).toMatchObject({ team: 'CAR', basis: 'preseason', basisGameId: 2026010042, basisGames: 5, generatedAt: '2026-09-28T08:00:00Z' })
    expect(body.lines[0].players.map(p => p.name)).toEqual(['Andrei Svechnikov', 'Sebastian Aho', 'Seth Jarvis'])
    expect(body.pairs[0].players.find(p => p.id === 8479402).filled).toBe(true)
    const urls = globalThis.fetch.mock.calls.map(c => c[0])
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('projected_lines?')
    expect(urls[0]).toContain('team=eq.CAR')
    expect(putSpy).toHaveBeenCalledWith('nhl:projected-lines:CAR', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('no projection yet: basis null, empty lists, not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    expect(await (await get(env, '?team=CAR')).json()).toEqual({ team: 'CAR', basis: null, basisGameId: null, basisGames: null, generatedAt: null, lines: [], pairs: [] })
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('rejects a malformed team', async () => {
    const env = makeEnv({ CACHE: { async get() { return null }, async put() {} } })
    globalThis.fetch = vi.fn()
    for (const qs of ['?team=CAROLINA', '?team=C1R', '?team=CAR),team.neq.x']) {
      expect((await get(env, qs)).status).toBe(400)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('degrades to unavailable on a Supabase failure and does not cache it', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await get(env, '?team=CAR')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ team: 'CAR', basis: null, lines: [], unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /scorecard (added alongside eyewall-pipeline's prediction_scorecard.py) ──
describe('GET /scorecard', () => {
  const rows = [
    { model: 'game_winner', kind: 'live', period: '2026-27', status: 'pending', n: 0, updated_at: '2026-09-14T12:40:00Z' },
    { model: 'game_winner', kind: 'backtest', period: '2023-24 to 2025-26', status: 'ok', n: 3936, accuracy: 0.5648, brier: 0.2419, updated_at: '2026-09-13T23:00:00Z' },
  ]
  const get = env => handleNHL(makeRequest('/scorecard'), env, makeCtx(), new URL('https://example.com/scorecard'))

  it('reads prediction_scorecard, groups it, caches 1hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => rows })

    const body = await (await get(env)).json()

    expect(body.models.game_winner.live).toMatchObject({ period: '2026-27', status: 'pending' })
    expect(body.models.game_winner.backtest).toMatchObject({ n: 3936, accuracy: 0.5648 })
    expect(body.updatedAt).toBe('2026-09-14T12:40:00Z')
    expect(globalThis.fetch.mock.calls[0][0]).toContain('prediction_scorecard?select=')
    expect(putSpy).toHaveBeenCalledWith('nhl:scorecard', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('an empty table is returned but not cached; a failed read is unavailable and not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    expect(await (await get(env)).json()).toEqual({ models: {}, updatedAt: null })

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await (await get(env)).json()).toMatchObject({ models: {}, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

// ── /elo/ratings (every team's rating + the home advantage, for win bars) ──
describe('GET /elo/ratings', () => {
  const ratingsRows = [{ team: 'CAR', rating: 1560.25 }, { team: 'FLA', rating: 1540 }]
  const get = env => handleNHL(makeRequest('/elo/ratings'), env, makeCtx(), new URL('https://example.com/elo/ratings'))

  it('returns every rating (unrounded) and the home advantage; caches 1hr', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ratingsRows })

    const body = await (await get(env)).json()

    expect(body).toEqual({ ratings: { CAR: 1560.25, FLA: 1540 }, homeAdvantage: 35 })
    expect(globalThis.fetch.mock.calls[0][0]).toContain('team_elo_ratings?select=team,rating')
    expect(putSpy).toHaveBeenCalledWith('nhl:elo-ratings', JSON.stringify(body), { expirationTtl: 3600 })
  })

  it('warm cache: serves directly from KV, no Supabase read', async () => {
    const cachedBody = { ratings: { CAR: 1500 }, homeAdvantage: 35 }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'nhl:elo-ratings' ? JSON.stringify(cachedBody) : null }, async put() {} } })
    globalThis.fetch = vi.fn()
    expect(await (await get(env)).json()).toEqual(cachedBody)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('an empty table is not cached; a failed read is unavailable and not cached', async () => {
    const putSpy = vi.fn()
    const env = makeEnv({ CACHE: { async get() { return null }, put: putSpy } })
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    expect(await (await get(env)).json()).toEqual({ ratings: {}, homeAdvantage: 35 })

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    expect(await (await get(env)).json()).toEqual({ ratings: {}, homeAdvantage: 35, unavailable: true })
    expect(putSpy).not.toHaveBeenCalled()
  })
})

describe('GET /player-analytics', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify({ rows: ['cached'], poRows: [] }) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: ['cached'], poRows: [] })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches from Supabase on a cache miss and caches the result', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ player_id: 1, war: 2.1 }],
    })

    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ player_id: 1, war: 2.1 }])
    // Cached for next time
    const cached = await env.CACHE.get('nhl:player-analytics:20252026')
    expect(JSON.parse(cached).rows).toEqual([{ player_id: 1, war: 2.1 }])
  })

  it('returns 502 when the Supabase fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(
      makeRequest('/player-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-analytics?season=20252026')
    )

    expect(res.status).toBe(502)
  })

  // Session 66: the live season can be flipped ahead of any real games
  // (schedule released before puck drop), leaving `war=not.is.null` match
  // nothing for it -- same whole-season-empty shape as
  // /players-search-index's team-lookup fallback (#22).
  describe('the live season has zero rows (season flipped ahead of real data)', () => {
    function mockFetchWithPriorSeason(priorRows) {
      globalThis.fetch = vi.fn((url) => {
        const u = String(url)
        if (u.includes('season=eq.20262027')) {
          return Promise.resolve({ ok: true, json: async () => [] }) // live season: nothing yet
        }
        if (u.includes('season=eq.20252026') && u.includes('game_type=eq.2')) {
          return Promise.resolve({ ok: true, json: async () => priorRows })
        }
        if (u.includes('season=eq.20252026') && u.includes('game_type=eq.3')) {
          return Promise.resolve({ ok: true, json: async () => [] })
        }
        throw new Error(`unexpected fetch: ${u}`)
      })
    }

    it('falls back one season back and flags the result as stale with the specific season, not just non-empty', async () => {
      mockFetchWithPriorSeason([{ player_id: 8478402, war: 4.2, pct_goals: 91 }])

      const res = await handleNHL(
        makeRequest('/player-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/player-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      // Asserts the specific fallback season and rows, not just "truthy" --
      // a wrong-season fallback would also satisfy a bare non-null check.
      expect(body).toEqual({
        rows: [{ player_id: 8478402, war: 4.2, pct_goals: 91 }],
        poRows: [],
        statsStale: true,
        statsSeason: '20252026',
      })
    })

    it('degrades to an explicit empty, non-stale result when the prior season has no rows either', async () => {
      mockFetchWithPriorSeason([]) // no rows in the prior season either

      const res = await handleNHL(
        makeRequest('/player-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/player-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ rows: [], poRows: [], statsStale: false, statsSeason: null })
    })
  })
})

describe('GET /goalie-analytics', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify({ rows: ['cached'], statsStale: false, statsSeason: null }) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/goalie-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/goalie-analytics?season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: ['cached'], statsStale: false, statsSeason: null })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches from Supabase on a cache miss and caches the result', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ player_id: 1, gsax: 4.2 }],
    })

    const res = await handleNHL(
      makeRequest('/goalie-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/goalie-analytics?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toEqual([{ player_id: 1, gsax: 4.2 }])
    const cached = await env.CACHE.get('nhl:goalie-analytics:20252026')
    expect(JSON.parse(cached).rows).toEqual([{ player_id: 1, gsax: 4.2 }])
  })

  it('returns 502 when the Supabase fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(
      makeRequest('/goalie-analytics?season=20252026'), env, makeCtx(),
      new URL('https://example.com/goalie-analytics?season=20252026')
    )

    expect(res.status).toBe(502)
  })

  // Regression: this route previously had no whole-season-empty fallback at
  // all (unlike /player-analytics's Session 66 fix) -- every goalie showed
  // "analytics not yet available" for the entire gap between a live season
  // flip and that season's first real games, not just goalies genuinely
  // below the GP/gsax-not-null floor. Found while wiring a header radar
  // chart for goalies (2026-08) that reused this exact route.
  describe('the live season has zero rows (season flipped ahead of real data)', () => {
    function mockFetchWithPriorSeason(priorRows, priorPlayoffRows = []) {
      globalThis.fetch = vi.fn((url) => {
        const u = String(url)
        if (u.includes('season=eq.20262027')) {
          return Promise.resolve({ ok: true, json: async () => [] }) // live season: nothing yet
        }
        if (u.includes('season=eq.20252026')) {
          const rows = u.includes('game_type=eq.3') ? priorPlayoffRows : priorRows
          return Promise.resolve({ ok: true, json: async () => rows })
        }
        throw new Error(`unexpected fetch: ${u}`)
      })
    }

    it('falls back one season back and flags the result as stale with the specific season', async () => {
      // Playoff rows come from the same (fallback) season as the rows.
      mockFetchWithPriorSeason(
        [{ player_id: 8479979, gsax: 12.4, pct_gsax: 88 }],
        [{ player_id: 8479979, gsax: 3.1 }],
      )

      const res = await handleNHL(
        makeRequest('/goalie-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/goalie-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        rows: [{ player_id: 8479979, gsax: 12.4, pct_gsax: 88 }],
        poRows: [{ player_id: 8479979, gsax: 3.1 }],
        statsStale: true,
        statsSeason: '20252026',
      })
    })

    it('degrades to an explicit empty, non-stale result when the prior season has no rows either', async () => {
      mockFetchWithPriorSeason([])

      const res = await handleNHL(
        makeRequest('/goalie-analytics?season=20262027'), makeEnv(), makeCtx(),
        new URL('https://example.com/goalie-analytics?season=20262027')
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ rows: [], poRows: [], statsStale: false, statsSeason: null })
    })
  })
})

describe('GET /player-results-vs-process', () => {
  it('400s when playerId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/player-results-vs-process?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?season=20252026')
    )
    expect(res.status).toBe(400)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRow = [{ narrative_text: 'cached blurb', generated_at: '2026-01-01' }]
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify(cachedRow) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=1&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=1&season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRow)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('fetches the narrative_type=results_vs_process row from Supabase on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ narrative_text: 'Kopitar is outperforming his process...', generated_at: '2026-01-01' }],
    })

    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=8471685&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=8471685&season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0].narrative_text).toContain('outperforming')

    const fetchedUrl = globalThis.fetch.mock.calls[0][0]
    expect(String(fetchedUrl)).toContain('player_narratives')
    expect(String(fetchedUrl)).toContain('narrative_type=eq.results_vs_process')
    expect(String(fetchedUrl)).toContain('player_id=eq.8471685')

    const cached = await env.CACHE.get('nhl:player-results-vs-process:8471685:20252026:en')
    expect(JSON.parse(cached)[0].narrative_text).toContain('outperforming')
  })

  it('defaults to locale=en when ?locale is omitted or unrecognized, and honors ?locale=fr', async () => {
    // Track B Phase B2 -- player_narratives is keyed on
    // (player_id, season, team, narrative_type, locale) as of Phase B0/B1
    // (eyewall-pipeline), so this filter and cache-key suffix are required
    // once both locales exist for the same player/season.
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ narrative_text: 'texte français', generated_at: '2026-01-01' }],
    })

    await handleNHL(
      makeRequest('/player-results-vs-process?playerId=1&season=20252026&locale=fr'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=1&season=20252026&locale=fr')
    )
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('locale=eq.fr')
    expect(await env.CACHE.get('nhl:player-results-vs-process:1:20252026:fr')).not.toBeNull()

    globalThis.fetch.mockClear()
    await handleNHL(
      makeRequest('/player-results-vs-process?playerId=2&season=20252026&locale=de'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=2&season=20252026&locale=de')
    )
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('locale=eq.en')
  })

  it('returns an empty array (not a 502) when the Supabase fetch fails', async () => {
    // Mirrors /player-scouting's swallow-and-return-[] behavior -- a missing
    // narrative shouldn't surface as an error to the player popup.
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await handleNHL(
      makeRequest('/player-results-vs-process?playerId=1&season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-results-vs-process?playerId=1&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /team-seasons', () => {
  it('selects magic/tragic number columns but not clinch_indicator (Session 59 — live standings is the clinch source of truth)', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', xgf_pct: 0.52, roster_war_score: 12.3, games_played: 60, magic_number: 4, tragic_number: 40, clinched: false, eliminated: false },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).toMatchObject({ team: 'CAR', magic_number: 4, tragic_number: 40, clinched: false, eliminated: false })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('magic_number')
    expect(fetchedUrl).toContain('tragic_number')
    expect(fetchedUrl).toContain('clinched')
    expect(fetchedUrl).toContain('eliminated')
    expect(fetchedUrl).not.toContain('clinch_indicator')
  })

  it('selects hits/penalties season totals (Session 82 — Shot Map "All N" cards)', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', xgf_pct: 0.52, roster_war_score: 12.3, games_played: 60, magic_number: 4, tragic_number: 40, clinched: false, eliminated: false, hits: 1450, penalties: 210 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body[0]).toMatchObject({ team: 'CAR', hits: 1450, penalties: 210 })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('hits')
    expect(fetchedUrl).toContain('penalties')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ team: 'CAR', magic_number: 2 }]
    const env = makeEnv({
      CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} },
    })
    const res = await handleNHL(
      makeRequest('/team-seasons?season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons?season=20252026')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /team-seasons/compare', () => {
  it('400s when team or seasons is missing', async () => {
    const env = makeEnv()
    const noTeam = await handleNHL(
      makeRequest('/team-seasons/compare?seasons=20262027,20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?seasons=20262027,20252026')
    )
    expect(noTeam.status).toBe(400)

    const noSeasons = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR')
    )
    expect(noSeasons.status).toBe(400)
  })

  it('queries box-score columns only (not xgf_pct/roster_war_score) for the given team + season list', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { season: 20262027, games_played: 5,  wins: 4, losses: 1, ot_losses: 0, points: 8,  goals_for: 20, goals_against: 10, pp_pct: 25.0, pk_pct: 80.0 },
        { season: 20252026, games_played: 82, wins: 45, losses: 30, ot_losses: 7, points: 97, goals_for: 260, goals_against: 230, pp_pct: 22.5, pk_pct: 78.3 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR&seasons=20262027,20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR&seasons=20262027,20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ season: 20262027, wins: 4, points: 8 })

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=eq.CAR')
    expect(fetchedUrl).toContain('season=in.(20262027,20252026)')
    expect(fetchedUrl).toContain('game_type=eq.2')
    expect(fetchedUrl).toContain('goals_for')
    expect(fetchedUrl).toContain('pp_pct')
    expect(fetchedUrl).not.toContain('xgf_pct')
    expect(fetchedUrl).not.toContain('roster_war_score')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ season: 20252026, wins: 45 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare?team=CAR&seasons=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare?team=CAR&seasons=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /team-seasons/compare-teams', () => {
  it('400s unless exactly two teams and a season are given', async () => {
    const env = makeEnv()
    const noSeason = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR')
    )
    expect(noSeason.status).toBe(400)

    const oneTeam = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR&season=20252026')
    )
    expect(oneTeam.status).toBe(400)

    const threeTeams = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR,BOS&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR,BOS&season=20252026')
    )
    expect(threeTeams.status).toBe(400)
  })

  it('queries both teams for one season, box-score columns only', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { team: 'CAR', season: 20252026, games_played: 82, wins: 45, losses: 30, ot_losses: 7, points: 97, goals_for: 260, goals_against: 230, pp_pct: 22.5, pk_pct: 78.3 },
        { team: 'NYR', season: 20252026, games_played: 82, wins: 40, losses: 35, ot_losses: 7, points: 87, goals_for: 240, goals_against: 235, pp_pct: 20.1, pk_pct: 79.0 },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR&season=20252026')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body.map(r => r.team)).toEqual(['CAR', 'NYR'])

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=in.(CAR,NYR)')
    expect(fetchedUrl).toContain('season=eq.20252026')
    expect(fetchedUrl).toContain('game_type=eq.2')
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedRows = [{ team: 'CAR', season: 20252026, wins: 45 }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedRows) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/compare-teams?teams=CAR,NYR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/team-seasons/compare-teams?teams=CAR,NYR&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedRows)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /team-seasons/head-to-head', () => {
  it('400s unless exactly two teams are given', async () => {
    const env = makeEnv()
    const oneTeam = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR')
    )
    expect(oneTeam.status).toBe(400)

    const threeTeams = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR,BOS'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR,BOS')
    )
    expect(threeTeams.status).toBe(400)
  })

  it('computes all-time record, recent window, and current streak from team A\'s perspective', async () => {
    const env = makeEnv()
    // 5 meetings, chronological -- CAR won games 1,2, lost 3, won 4,5.
    // Current streak: 2 straight CAR wins (games 4,5). Window is
    // min(10,5)=5, so recentWindow equals the all-time record here.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { game_id: 1, season: 20232024, game_date: '2023-11-01', team_score: 4, opp_score: 2, home_team: true },
        { game_id: 2, season: 20232024, game_date: '2024-01-10', team_score: 3, opp_score: 1, home_team: false },
        { game_id: 3, season: 20242025, game_date: '2024-11-05', team_score: 1, opp_score: 5, home_team: true },
        { game_id: 4, season: 20252026, game_date: '2025-11-01', team_score: 2, opp_score: 0, home_team: false },
        { game_id: 5, season: 20252026, game_date: '2026-01-15', team_score: 6, opp_score: 3, home_team: true },
      ],
    })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.teamA).toBe('CAR')
    expect(body.teamB).toBe('NYR')
    expect(body.totalMeetings).toBe(5)
    expect(body.allTimeRecord).toEqual({ teamAWins: 4, teamBWins: 1 })
    expect(body.recentWindow).toEqual({ size: 5, teamAWins: 4, teamBWins: 1 })
    expect(body.currentStreak).toEqual({ holder: 'A', count: 2 })
    expect(body.isThinSample).toBe(false)
    expect(body.games).toHaveLength(5)

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('team=eq.CAR')
    expect(fetchedUrl).toContain('opponent=eq.NYR')
    expect(fetchedUrl).not.toContain('game_type=')
    expect(fetchedUrl).not.toContain('season=eq.')
  })

  it('flags a thin sample and reports zero meetings without erroring', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=DET,SEA'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=DET,SEA')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalMeetings).toBe(0)
    expect(body.currentStreak).toBeNull()
    expect(body.isThinSample).toBe(false)
  })

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedPayload = { teamA: 'CAR', teamB: 'NYR', totalMeetings: 5 }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedPayload) }, async put() {} } })

    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head?teams=CAR,NYR'), env, makeCtx(),
      new URL('https://example.com/team-seasons/head-to-head?teams=CAR,NYR')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedPayload)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('POST /team-seasons/head-to-head/narrative', () => {
  const basePayload = {
    teamA: 'CAR', teamB: 'NYR', teamADisplay: 'Carolina Hurricanes', teamBDisplay: 'New York Rangers',
    totalMeetings: 5,
    allTimeRecord: { teamAWins: 4, teamBWins: 1 },
    recentWindow: { size: 5, teamAWins: 4, teamBWins: 1 },
    currentStreak: { holder: 'A', count: 2 },
    isThinSample: false,
  }

  it('returns a null narrative without calling the AI model when there are zero meetings', async () => {
    const env = makeEnv()
    mockFetchWithAI('should not be called')
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: { ...basePayload, totalMeetings: 0 } }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).narrative).toBeNull()
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  it('returns an error on invalid JSON body', async () => {
    const env = makeEnv()
    const req = new Request('https://example.com/team-seasons/head-to-head/narrative', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    const res = await handleNHL(req, env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative'))
    expect((await res.json()).error).toMatch(/invalid json/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { narrative: 'cached narrative' }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'nhl:h2h-narrative:CAR,NYR' ? JSON.stringify(cached) : null }, async put() {} } })
    mockFetchWithAI('should not be called')
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: basePayload }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(await res.json()).toEqual(cached)
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  it('generates and caches a narrative, sorting the cache key regardless of team order', async () => {
    const env = makeEnv()
    mockFetchWithAI('Carolina leads this series.')
    const res = await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: basePayload }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.narrative).toBe('Carolina leads this series.')
    expect(aiCalls(globalThis.fetch)).toHaveLength(1)
    expect(JSON.parse(await env.CACHE.get('nhl:h2h-narrative:CAR,NYR')).narrative).toBe('Carolina leads this series.')
  })

  it('includes a thin-sample guardrail note in the prompt when isThinSample is true', async () => {
    const env = makeEnv()
    mockFetchWithAI('Too early to say much.')
    await handleNHL(
      makeRequest('/team-seasons/head-to-head/narrative', { method: 'POST', body: { ...basePayload, totalMeetings: 2, isThinSample: true } }),
      env, makeCtx(), new URL('https://example.com/team-seasons/head-to-head/narrative')
    )
    const prompt = aiPrompt(globalThis.fetch)[0].content
    expect(prompt).toMatch(/too small a sample/i)
  })
})

describe('GET /player-shots', () => {
  it('400s when playerId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/player-shots?season=20252026'), env, makeCtx(),
      new URL('https://example.com/player-shots?season=20252026')
    )
    expect(res.status).toBe(400)
  })

  // Regression: car_game on the shot_events table only means "Carolina
  // played in this game" (see eyewall-pipeline's shot_events.py), not
  // "the requested team played in this game" -- filtering on it here
  // silently restricted every non-CAR player's shots to games against
  // Carolina. Assert it's gone from the outbound query, and that a non-CAR
  // team param is passed through untouched.
  it('does not filter on car_game, and passes a non-CAR team through', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    await handleNHL(
      makeRequest('/player-shots?playerId=8478402&season=20252026&team=TOR'), env, makeCtx(),
      new URL('https://example.com/player-shots?playerId=8478402&season=20252026&team=TOR')
    )

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).not.toContain('car_game')
    expect(fetchedUrl).toContain('team=eq.TOR')
    expect(fetchedUrl).toContain('player_id=eq.8478402')
  })
})

// shot_events and game_xg hold a season's preseason and playoff games as
// well as its regular season. These routes read one game type: regular
// season by default, playoffs with gameType=3, and never preseason.
// line_combinations and special_teams_units are built per game type and
// never from preseason; these routes read one game type.
describe('game type on /team-lines and /special-teams', () => {
  async function call(path) {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    const res = await handleNHL(makeRequest(path), makeEnv(), makeCtx(), new URL(`https://example.com${path}`))
    return { res, url: String(globalThis.fetch.mock.calls[0]?.[0]) }
  }

  it('/team-lines reads the regular season by default, with source', async () => {
    const { url } = await call('/team-lines?team=CAR&season=20262027')
    expect(url).toContain('game_type=eq.2')
    expect(url).toContain(',source')
  })

  it('/team-lines reads playoff units with gameType=3', async () => {
    const { url } = await call('/team-lines?team=CAR&season=20252026&gameType=3')
    expect(url).toContain('game_type=eq.3')
  })

  it.each(['/team-lines?team=CAR&season=20262027', '/special-teams?season=20262027'])(
    '%s 400s on preseason or junk gameType', async (path) => {
      for (const gameType of ['1', 'abc']) {
        const { res } = await call(`${path}&gameType=${gameType}`)
        expect(res.status).toBe(400)
      }
    }
  )

  it('/team-lines 502s on a failed read instead of caching []', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const env = makeEnv()
    const path = '/team-lines?team=CAR&season=20262027'
    const res = await handleNHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
    expect(res.status).toBe(502)
    expect(await env.CACHE.get('nhl:team-lines:CAR:20262027:2')).toBeNull()
  })
})

describe('game type on /player-shots, /goalie-shots, /xg-trend', () => {
  const ROUTES = [
    '/player-shots?playerId=8478402&season=20252026&team=TOR',
    '/goalie-shots?goalieId=8481611&season=20252026',
    '/xg-trend?team=TOR&season=20252026',
  ]

  async function fetchedUrlFor(path) {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
    const res = await handleNHL(makeRequest(path), makeEnv(), makeCtx(), new URL(`https://example.com${path}`))
    return { res, url: String(globalThis.fetch.mock.calls[0]?.[0]) }
  }

  it.each(ROUTES)('%s reads the regular season by default', async (path) => {
    const { url } = await fetchedUrlFor(path)
    expect(url).toContain('game_type=eq.2')
  })

  it.each(ROUTES)('%s reads playoffs with gameType=3', async (path) => {
    const { url } = await fetchedUrlFor(`${path}&gameType=3`)
    expect(url).toContain('game_type=eq.3')
  })

  it.each(ROUTES)('%s 400s on preseason or junk gameType', async (path) => {
    for (const gameType of ['1', 'abc']) {
      const { res } = await fetchedUrlFor(`${path}&gameType=${gameType}`)
      expect(res.status).toBe(400)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /nhl/shots', () => {
  // Regression: an earlier version of this route filtered shot_events on
  // car_game=eq.true, which only ever means "Carolina played in this game"
  // -- for any other requested team that would have silently returned
  // CAR's shots instead of the requested team's. Assert the route resolves
  // the requested team's own game_ids from the NHL schedule API first and
  // scopes shot_events by that game_id list instead.
  it('resolves game_ids from the requested (non-CAR) team schedule, not car_game', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        expect(u).toContain('club-schedule-season/TOR/20252026')
        return Promise.resolve({
          ok: true,
          json: async () => ({
            games: [
              { id: 2025020001, gameState: 'OFF' },
              { id: 2025020002, gameState: 'FUT' }, // not completed -- excluded
              { id: 2025020003, gameState: 'FINAL' },
            ],
          }),
        })
      }
      // Supabase shot_events call
      expect(u).not.toContain('car_game')
      expect(u).toContain('game_id=in.(2025020001,2025020003)')
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=TOR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=TOR&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // The "All N" view's dots come from this route, so a goal there can only
  // offer its video or its tracking replay if the row carries the NHL's own
  // event id -- (game_id, event_id) is what /nhl/goal-replay takes.
  it('asks for each row\'s event id, and passes it through', async () => {
    const env = makeEnv()
    const row = {
      game_id: 2025020001, event_id: 59, team: 'TOR', x: 80, y: 3,
      event_type: 'goal', period: 1, time_in_period: '09:14', shot_type: 'wrist',
    }
    let shotQuery = ''
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [{ id: 2025020001, gameState: 'OFF' }] }) })
      }
      shotQuery = u
      return Promise.resolve({ ok: true, json: async () => [row] })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=TOR&season=20252026'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=TOR&season=20252026')
    )

    expect(shotQuery).toContain('event_id')
    expect(await res.json()).toEqual([{ ...row, shooter_name: null, goalie_name: null, assist1_name: null, assist2_name: null, blocker_name: null }])
  })

  // The popup said "Unknown" for every season dot: the rows had no player.
  it('names each row\'s shooter and goalie from the players table', async () => {
    const env = makeEnv()
    const rows = [
      { game_id: 2026020001, event_id: 190, team: 'FLA', x: 81, y: 6, event_type: 'missed-shot', period: 1, time_in_period: '08:56', shot_type: 'tip-in', player_id: 8479314, goalie_id: 8483548 },
      { game_id: 2026020001, event_id: 200, team: 'CAR', x: -70, y: 2, event_type: 'shot-on-goal', period: 1, time_in_period: '10:00', shot_type: 'wrist', player_id: 8478427, goalie_id: 9999999 },
    ]
    let shotQuery = ''
    let playersQuery = ''
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [{ id: 2026020001, gameState: 'OFF' }] }) })
      }
      if (u.includes('/rest/v1/players')) {
        playersQuery = u
        return Promise.resolve({ ok: true, json: async () => [
          { id: 8479314, name: 'Matthew Tkachuk' },
          { id: 8483548, name: 'Brandon Bussi' },
          { id: 8478427, name: 'Sebastian Aho' },
        ] })
      }
      shotQuery = u
      return Promise.resolve({ ok: true, json: async () => rows })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=CAR&season=20262027'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=CAR&season=20262027')
    )

    expect(shotQuery).toContain('player_id,goalie_id')
    // one lookup, each id once
    expect(playersQuery).toContain('id=in.(8479314,8483548,8478427,9999999)')
    const body = await res.json()
    expect(body[0]).toMatchObject({ shooter_name: 'Matthew Tkachuk', goalie_name: 'Brandon Bussi' })
    // an id the players table doesn't have stays null, never a guess
    expect(body[1]).toMatchObject({ shooter_name: 'Sebastian Aho', goalie_name: null })
  })

  it('names a goal\'s assists and a blocked shot\'s blocker', async () => {
    const env = makeEnv()
    const rows = [
      { game_id: 2026020001, event_id: 1, team: 'FLA', x: 85, y: 0, event_type: 'goal', period: 1, time_in_period: '04:00', shot_type: 'wrist', player_id: 8479314, goalie_id: 8483548, assist1_id: 8477493, assist2_id: 8478366, blocker_id: null },
      { game_id: 2026020001, event_id: 2, team: 'FLA', x: 60, y: 5, event_type: 'blocked-shot', period: 1, time_in_period: '06:00', shot_type: null, player_id: 8479314, goalie_id: null, assist1_id: null, assist2_id: null, blocker_id: 8478427 },
    ]
    let shotQuery = ''
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [{ id: 2026020001, gameState: 'OFF' }] }) })
      }
      if (u.includes('/rest/v1/players')) {
        return Promise.resolve({ ok: true, json: async () => [
          { id: 8479314, name: 'Matthew Tkachuk' }, { id: 8483548, name: 'Brandon Bussi' },
          { id: 8477493, name: 'Aleksander Barkov' }, { id: 8478366, name: 'Sam Reinhart' },
          { id: 8478427, name: 'Sebastian Aho' },
        ] })
      }
      shotQuery = u
      return Promise.resolve({ ok: true, json: async () => rows })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=CAR&season=20262027'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=CAR&season=20262027')
    )

    expect(shotQuery).toContain('assist1_id,assist2_id,blocker_id')
    const [goal, block] = await res.json()
    expect(goal).toMatchObject({ assist1_name: 'Aleksander Barkov', assist2_name: 'Sam Reinhart', blocker_name: null })
    expect(block).toMatchObject({ shooter_name: 'Matthew Tkachuk', blocker_name: 'Sebastian Aho', assist1_name: null })
  })

  it('still serves the dots, unnamed and uncached, when the name lookup fails', async () => {
    const env = makeEnv()
    const put = vi.spyOn(env.CACHE, 'put')
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [{ id: 2026020001, gameState: 'OFF' }] }) })
      }
      if (u.includes('/rest/v1/players')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
      return Promise.resolve({ ok: true, json: async () => [{ game_id: 2026020001, event_id: 1, team: 'CAR', x: 1, y: 1, event_type: 'goal', period: 1, time_in_period: '01:00', shot_type: 'wrist', player_id: 8478427, goalie_id: 8479314 }] })
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=CAR&season=20262027'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=CAR&season=20262027')
    )

    expect(res.status).toBe(200)
    expect((await res.json())[0]).toMatchObject({ event_id: 1, shooter_name: null, goalie_name: null })
    expect(put).not.toHaveBeenCalledWith(expect.stringContaining('nhl:shots'), expect.anything(), expect.anything())
  })

  it('returns an empty array without querying Supabase when the team has no completed games', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ id: 1, gameState: 'FUT' }] }),
    })

    const res = await handleNHL(
      makeRequest('/nhl/shots?team=SEA&season=20252026'), env, makeCtx(),
      new URL('https://example.com/nhl/shots?team=SEA&season=20252026')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // schedule only, no Supabase call
  })
})

describe('GET /milestones', () => {
  // Regression: an unfiltered "order by game_date desc, limit N" query has
  // no way to age out an old row once the table stops getting new ones
  // (e.g. NHL offseason) -- a single leftover milestone from last season
  // sat as the ONLY NHL row for over a month with nothing newer to push it
  // off. Assert the live-resolved current season is applied as a real
  // filter, for both NHL and PWHL.
  it('scopes the Supabase query to the live-resolved current NHL season', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    await handleNHL(
      makeRequest('/milestones'), env, makeCtx(),
      new URL('https://example.com/milestones')
    )

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('is_pwhl=eq.false')
    expect(fetchedUrl).toContain('season=eq.20252026')
  })

  it('scopes the Supabase query to the live-resolved current PWHL season', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    await handleNHL(
      makeRequest('/milestones?sport=pwhl'), env, makeCtx(),
      new URL('https://example.com/milestones?sport=pwhl')
    )

    const fetchedUrl = String(globalThis.fetch.mock.calls[0][0])
    expect(fetchedUrl).toContain('is_pwhl=eq.true')
    expect(fetchedUrl).toContain('season=eq.8')
  })
})

describe('POST /push/subscribe', () => {
  it('adds a new subscription and defaults league prefix to NHL', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { endpoint: 'ep-1', keys: { p256dh: 'x', auth: 'y' } } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).total).toBe(1)
    const stored = JSON.parse(await env.CACHE.get('push:subs'))
    expect(stored).toEqual([{ endpoint: 'ep-1', keys: { p256dh: 'x', auth: 'y' }, teamAbbr: 'NHL:CAR', prefs: null }])
  })

  it('updates in place (dedupes by endpoint) on re-subscribe rather than appending a duplicate', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([{ endpoint: 'ep-1', teamAbbr: 'NHL:CAR', prefs: null }])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { endpoint: 'ep-1', teamAbbr: 'BOS' } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect((await res.json()).total).toBe(1)
  })

  it('stores several teams with their own alert choices, keeping the first as teamAbbr/prefs', async () => {
    const env = makeEnv()
    await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: {
        endpoint: 'ep-2', keys: { p256dh: 'x', auth: 'y' },
        teams: [
          { key: 'nhl:car', prefs: { goal: true, periodEnd: false, junk: 'x' } },
          { key: 'PWHL:MIN', prefs: null },
          { key: 'NHL:CAR', prefs: null },   // repeat
          { key: 'XFL:BAD', prefs: null },   // not a league
        ],
      } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )
    const [stored] = JSON.parse(await env.CACHE.get('push:subs'))
    expect(stored.teams).toEqual([
      { key: 'NHL:CAR', prefs: { goal: true, periodEnd: false } },
      { key: 'PWHL:MIN', prefs: null },
    ])
    expect(stored.teamAbbr).toBe('NHL:CAR')
    expect(stored.prefs).toEqual({ goal: true, periodEnd: false })
  })

  // Native iOS push (2026-09) -- platform: 'ios' + an APNs device token,
  // sharing the same push:subs array and route as Web Push above.
  it('accepts a native iOS subscription, storing token instead of endpoint/keys', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { platform: 'ios', token: 'device-token-1', teamAbbr: 'CAR' } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).total).toBe(1)
    const stored = JSON.parse(await env.CACHE.get('push:subs'))
    expect(stored).toEqual([{ platform: 'ios', token: 'device-token-1', teamAbbr: 'NHL:CAR', prefs: null }])
  })

  it('dedupes iOS subscriptions by token, not endpoint', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([{ platform: 'ios', token: 'device-token-1', teamAbbr: 'NHL:CAR', prefs: null }])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/subscribe', { method: 'POST', body: { platform: 'ios', token: 'device-token-1', teamAbbr: 'BOS' } }),
      env, makeCtx(), new URL('https://example.com/push/subscribe')
    )

    expect((await res.json()).total).toBe(1)
  })
})

describe('POST /push/unsubscribe', () => {
  it('removes the matching subscription by endpoint', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([{ endpoint: 'ep-1' }, { endpoint: 'ep-2' }])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/unsubscribe', { method: 'POST', body: { endpoint: 'ep-1' } }),
      env, makeCtx(), new URL('https://example.com/push/unsubscribe')
    )

    expect((await res.json()).total).toBe(1)
  })

  it('removes the matching iOS subscription by token, leaving Web Push subs untouched', async () => {
    const env = makeEnv({
      CACHE: {
        async get() {
          return JSON.stringify([
            { platform: 'ios', token: 'device-token-1' },
            { endpoint: 'ep-1' },
          ])
        },
        async put() {},
      },
    })
    const res = await handleNHL(
      makeRequest('/push/unsubscribe', { method: 'POST', body: { token: 'device-token-1' } }),
      env, makeCtx(), new URL('https://example.com/push/unsubscribe')
    )

    expect((await res.json()).total).toBe(1)
  })
})

describe('GET /news (cold cache background-fetch pattern)', () => {
  it('returns [] immediately on a cache miss and schedules a background fetch via ctx.waitUntil', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) })
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/news'), env, ctx, new URL('https://example.com/news')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx) // let the background fetch settle before the test ends
  })
})

// ── Tier 2 — POLL_SECRET-gated mutating/ingest routes (Session 48, Item 2) ──
// Each of these asserts the actual KV mutation/merge logic per the Session
// 48 decision, not just the response status code.

describe('POST /atom/ingest', () => {
  const ATOM_XML = '<?xml version="1.0"?><feed><entry><title>Canes win big</title><link href="https://example.com/article1"/><summary>Great game recap</summary><published>2026-07-08T00:00:00Z</published></entry></feed>'

  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/atom/ingest', { method: 'POST', body: { canescountry: ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('merges parsed atom articles into news:ABBR, preserving items from other sources', async () => {
    const existing = [{ id: 'other-old1', source: 'other-source', title: 'Old article from elsewhere', publishedAt: '2020-01-01T00:00:00Z' }]
    const env = makeEnv({ CACHE: makeFakeCache({ 'news:CAR': existing }) })

    const res = await handleNHL(
      makeRequest('/atom/ingest?secret=test-poll-secret', { method: 'POST', body: { canescountry: ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.canescountry).toBe(1)

    const merged = JSON.parse(await env.CACHE.get('news:CAR'))
    expect(merged).toHaveLength(2)
    expect(merged.some(i => i.source === 'other-source')).toBe(true)
  })

  it('auto-detects plain RSS 2.0 (not just true Atom) — the newer /feed/-path blogs use RSS, not Atom', async () => {
    // wingingitinmotown etc. -- confirmed live (Session: news ingestion
    // investigation) to return <rss>/<item>, not <feed>/<entry>. This
    // route must parse both without needing per-source configuration.
    const RSS_XML = '<?xml version="1.0"?><rss version="2.0"><channel><item><title>Wings sign a d-man</title><link>https://example.com/wings-article</link><description>Depth move</description><pubDate>Tue, 08 Jul 2026 00:00:00 GMT</pubDate></item></channel></rss>'
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    // wingingitinmotown must exist as a real atom-type TEAM_NEWS_SOURCES
    // entry for DET for the reverse lookup to resolve it -- this asserts
    // against the real config, not a stub, so it breaks loudly if that
    // entry's id or type ever changes.
    const res = await handleNHL(
      makeRequest('/atom/ingest?secret=test-poll-secret', { method: 'POST', body: { wingingitinmotown: RSS_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.wingingitinmotown).toBe(1)
    const merged = JSON.parse(await env.CACHE.get('news:DET'))
    expect(merged[0].title).toBe('Wings sign a d-man')
  })

  it('ignores an unrecognized source id', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/atom/ingest?secret=test-poll-secret', { method: 'POST', body: { 'not-a-real-source': ATOM_XML } }),
      env, makeCtx(), new URL('https://example.com/atom/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual({})
  })
})

describe('POST /moneypuck/ingest', () => {
  const CSV = 'playerId,name,team,situation,icetime\n' +
    '1,Player One,CAR,all,72000\n' +
    '2,Player Two,CAR,5on5,60000\n' +
    '3,Player Three,BOS,all,50000\n'

  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/ingest', { method: 'POST', body: CSV }),
      env, makeCtx(), new URL('https://example.com/moneypuck/ingest')
    )
    expect(res.status).toBe(401)
  })

  it('400s on a too-short body', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/ingest?secret=test-poll-secret', { method: 'POST', body: 'too short' }),
      env, makeCtx(), new URL('https://example.com/moneypuck/ingest?secret=test-poll-secret')
    )
    expect(res.status).toBe(400)
  })

  it('stores raw rows, clears every team\'s cache, and kicks off background computation for all 32 teams', async () => {
    const env = makeEnv()
    const ctx = makeCtx()

    const res = await handleNHL(
      makeRequest('/moneypuck/ingest?secret=test-poll-secret', { method: 'POST', body: CSV }),
      env, ctx, new URL('https://example.com/moneypuck/ingest?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toBe(3)
    expect(body.teams).toBe(32)

    const raw = JSON.parse(await env.CACHE.get('moneypuck:raw'))
    expect(raw).toHaveLength(3)
    expect(ctx._promises.length).toBe(32)
    await flushWaitUntil(ctx)
  })
})

describe('GET /moneypuck/refresh/all', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/refresh/all'), env, makeCtx(), new URL('https://example.com/moneypuck/refresh/all')
    )
    expect(res.status).toBe(401)
  })

  it('clears the shared + per-team caches and refreshes all 32 teams in the background', async () => {
    const env = makeEnv({
      CACHE: {
        _deleted: [],
        async get() { return null },
        async put() {},
        async delete(key) { this._deleted.push(key) },
      },
    })
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'playerId,name\n1,X\n' })

    const res = await handleNHL(
      makeRequest('/moneypuck/refresh/all?secret=test-poll-secret'), env, ctx,
      new URL('https://example.com/moneypuck/refresh/all?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    expect(env.CACHE._deleted).toContain('moneypuck:raw')
    expect(env.CACHE._deleted.filter(k => k.startsWith('moneypuck:skaters:'))).toHaveLength(32)
    expect(ctx._promises.length).toBe(32)
    await flushWaitUntil(ctx)
  })
})

describe('GET /moneypuck/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/moneypuck/refresh'), env, makeCtx(), new URL('https://example.com/moneypuck/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('clears the team + raw cache and refreshes in the background', async () => {
    const env = makeEnv({
      CACHE: {
        _deleted: [],
        async get() { return null },
        async put() {},
        async delete(key) { this._deleted.push(key) },
      },
    })
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => 'playerId,name\n1,X\n' })

    const res = await handleNHL(
      makeRequest('/moneypuck/refresh?secret=test-poll-secret&team=CAR'), env, ctx,
      new URL('https://example.com/moneypuck/refresh?secret=test-poll-secret&team=CAR')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).team).toBe('CAR')
    expect(env.CACHE._deleted).toEqual(expect.arrayContaining(['moneypuck:skaters:CAR', 'moneypuck:raw']))
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx)
  })
})

describe('GET /pp-units/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/pp-units/refresh'), env, makeCtx(), new URL('https://example.com/pp-units/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('kicks off refreshPPUnits in the background', async () => {
    const env = makeEnv()
    const ctx = makeCtx()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })

    const res = await handleNHL(
      makeRequest('/pp-units/refresh?secret=test-poll-secret'), env, ctx,
      new URL('https://example.com/pp-units/refresh?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    expect(ctx._promises.length).toBe(1)
    await flushWaitUntil(ctx)
  })
})

describe('GET /summary/generate', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/generate'), env, makeCtx(), new URL('https://example.com/summary/generate')
    )
    expect(res.status).toBe(401)
  })

  it('returns an error when there are no completed games in the schedule', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/generate?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/summary/generate?secret=test-poll-secret')
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/no completed games/i)
  })
})

describe('GET /news/refresh', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/news/refresh'), env, makeCtx(), new URL('https://example.com/news/refresh')
    )
    expect(res.status).toBe(401)
  })

  it('fetches fresh news for the requested team and reports the count', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) // every source fails — count 0, no crash
    const res = await handleNHL(
      makeRequest('/news/refresh?secret=test-poll-secret&team=CAR'), env, makeCtx(),
      new URL('https://example.com/news/refresh?secret=test-poll-secret&team=CAR')
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, count: 0, team: 'CAR' })
  })
})

describe('GET /poll (manual trigger)', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/poll'), env, makeCtx(), new URL('https://example.com/poll')
    )
    expect(res.status).toBe(401)
  })

  it('runs the poll loop and reports a timestamp', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ games: [], standings: [] }),
    })

    const res = await handleNHL(
      makeRequest('/poll?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/poll?secret=test-poll-secret')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.polled).toBeTruthy()
  })
})

// Regression coverage for the 2026-07 multi-team poll-loop rewrite: poll()
// used to only ever fetch CAR's own schedule and could only ever detect
// CAR's own live/just-ended game, so push notifications never fired for
// any other team's subscribers, no matter what they'd subscribed to. It
// now fetches the league-wide /score/now scoreboard and processes every
// live/completed game, dual-broadcasting to both teams playing (mirroring
// pollPWHLGame's pattern in pwhl.js) instead of framing everything as
// "CAR" vs "opponent". sendPush is mocked (see top of file) so these
// assert on *who* got notified, not on real push-service delivery.
describe('poll() — multi-team dual broadcast', () => {
  // The file-level resolveNHLSeason mock returns a fixed 20252026, whose
  // computed season-end (2026-07-01) is now in the past relative to
  // whenever this suite actually runs -- poll() no-ops immediately in that
  // case (see its "Season over" early return). Override to a season safely
  // in the future so poll() actually runs its body in these tests.
  beforeEach(() => {
    const nextYear = new Date().getFullYear() + 2
    vi.mocked(resolveNHLSeason).mockResolvedValue(Number(`${nextYear - 1}${nextYear}`))
  })

  // mockResolvedValue (not -Once) persists past this describe block's own
  // tests since resolveNHLSeason is a shared module-level mock -- restore
  // the file's default so later describe blocks (which assume 20252026,
  // e.g. for their `schedule:CAR:20252026`-shaped cache keys) aren't
  // silently broken by this one.
  afterEach(() => {
    vi.mocked(resolveNHLSeason).mockResolvedValue(20252026)
  })

  function subFor(teamAbbr, endpoint) {
    return { endpoint, keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `NHL:${teamAbbr}` }
  }

  function mockScoreboardAndPbp({ liveGames = [], completedGames = [], pbpByGameId = {}, scheduleGames = [] }) {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url)
      if (u.includes('/score/now')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: [...liveGames, ...completedGames] }) })
      }
      if (u.includes('/play-by-play')) {
        const gid = u.match(/gamecenter\/(\d+)\//)?.[1]
        return Promise.resolve({ ok: true, json: async () => pbpByGameId[gid] || { plays: [] } })
      }
      if (u.includes('club-schedule-season')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: scheduleGames }) })
      }
      // boxscore, standings, team/summary, odds, news — not under test here
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })
  }

  it('dual-broadcasts a goal to both teams playing, not just this app\'s own team', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('BOS', 'https://push.example/bos-fan'), subFor('CAR', 'https://push.example/car-fan')],
      }),
    })

    const liveGame = {
      id: 2025020555, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 6, abbrev: 'BOS', score: 1 },
      awayTeam: { id: 12, abbrev: 'CAR', score: 0 },
    }
    mockScoreboardAndPbp({
      liveGames: [liveGame],
      pbpByGameId: {
        '2025020555': {
          periodDescriptor: { number: 1 },
          plays: [{
            typeDescKey: 'goal',
            details: { eventOwnerTeamId: 6, scoringPlayerName: 'David Pastrnak', scoringPlayerId: 88, shotType: 'wrist' },
          }],
        },
      },
    })

    await poll(env, makeCtx())

    const calls = sendPushMock.mock.calls
    const bosCalls = calls.filter(([sub]) => sub.endpoint.includes('bos-fan'))
    const carCalls = calls.filter(([sub]) => sub.endpoint.includes('car-fan'))
    expect(bosCalls.length).toBeGreaterThan(0)
    expect(carCalls.length).toBeGreaterThan(0)

    const bosGoalCall = bosCalls.find(([, payload]) => payload.tag?.startsWith('goal-'))
    const carOppGoalCall = carCalls.find(([, payload]) => payload.tag?.startsWith('opp-goal-'))
    expect(bosGoalCall?.[1].title).toContain('GOAL')
    expect(bosGoalCall?.[1].title).toContain('BOS')
    expect(carOppGoalCall?.[1].title).toContain('BOS scores')
  })

  // Followed teams (2026-09): a device following both teams in a game gets
  // each alert once, from the side of the team higher in its list.
  it('sends a fan of both teams one goal alert, framed for the team they list first', async () => {
    sendPushMock.mockClear()
    const both = {
      endpoint: 'https://push.example/car-then-bos', keys: { p256dh: 'x', auth: 'y' },
      teamAbbr: 'NHL:CAR', prefs: null,
      teams: [{ key: 'NHL:CAR', prefs: null }, { key: 'NHL:BOS', prefs: null }],
    }
    const env = makeEnv({ VAPID_PRIVATE_KEY: 'fake-key-for-test', CACHE: makeFakeCache({ 'push:subs': [both] }) })
    mockScoreboardAndPbp({
      liveGames: [{
        id: 2025020557, gameState: 'LIVE', gameType: 2,
        homeTeam: { id: 6, abbrev: 'BOS', score: 1 },
        awayTeam: { id: 12, abbrev: 'CAR', score: 0 },
      }],
      pbpByGameId: {
        '2025020557': {
          periodDescriptor: { number: 1 },
          plays: [{
            typeDescKey: 'goal',
            details: { eventOwnerTeamId: 6, scoringPlayerName: 'David Pastrnak', scoringPlayerId: 88, shotType: 'wrist' },
          }],
        },
      },
    })

    await poll(env, makeCtx())

    const goalCalls = sendPushMock.mock.calls.filter(([, p]) => /goal-/.test(p.tag || ''))
    expect(goalCalls).toHaveLength(1)
    expect(goalCalls[0][1].tag).toMatch(/^opp-goal-/) // CAR's side: "BOS scores"
  })

  it('pushes a Live Activity update only when the state changed, at priority 5 for a clock-only change', async () => {
    sendLiveActivityPushMock.mockClear()
    const env = makeEnv({ CACHE: makeFakeCache({ 'la:tokens:2025020600': ['ab'.repeat(32)] }) })
    const liveGame = {
      id: 2025020600, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 12, abbrev: 'CAR', score: 1 },
      awayTeam: { id: 13, abbrev: 'FLA', score: 0 },
    }
    const pbpAt = clock => ({ periodDescriptor: { number: 1, periodType: 'REG' }, clock: { timeRemaining: clock }, plays: [] })
    mockScoreboardAndPbp({ liveGames: [liveGame], pbpByGameId: { '2025020600': pbpAt('12:00') } })
    await poll(env, makeCtx())
    await poll(env, makeCtx()) // unchanged -> no second push
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(1)
    expect(sendLiveActivityPushMock.mock.calls[0][1]).toMatchObject({ event: 'update', priority: 10 })

    mockScoreboardAndPbp({ liveGames: [liveGame], pbpByGameId: { '2025020600': pbpAt('11:00') } })
    await poll(env, makeCtx())
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(2)
    expect(sendLiveActivityPushMock.mock.calls[1][1]).toMatchObject({ priority: 5, state: { clock: '11:00' } })
  })

  it('ends Live Activities with the final score, and drops a dead token', async () => {
    sendLiveActivityPushMock.mockClear()
    sendLiveActivityPushMock.mockResolvedValueOnce('ok').mockResolvedValueOnce('expired')
    const good = 'aa'.repeat(32), dead = 'bb'.repeat(32)
    const env = makeEnv({ CACHE: makeFakeCache({ 'la:tokens:2025020601': [good, dead] }) })
    const finalGame = {
      id: 2025020601, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-15',
      homeTeam: { id: 12, abbrev: 'CAR', score: 3 }, awayTeam: { id: 13, abbrev: 'FLA', score: 2 },
      gameOutcome: { lastPeriodType: 'OT' },
    }
    mockScoreboardAndPbp({ completedGames: [finalGame] })
    await poll(env, makeCtx())
    expect(sendLiveActivityPushMock.mock.calls[0][1]).toMatchObject({
      event: 'end', state: { status: 'final', homeScore: 3, awayScore: 2, periodLabel: 'OT' },
    })
    const kept = await env.CACHE.get('la:tokens:2025020601')
    expect(JSON.parse(kept)).toEqual([good])
  })

  it('sends End of P1 when the intermission starts, not when P2 does', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('CAR', 'https://push.example/car-fan')],
        'push:gamestate:2025020556': { homeScore: 1, awayScore: 0, playCount: 1, started: true, period: 1, goalScorers: {} },
      }),
    })
    const liveGame = {
      id: 2025020556, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 12, abbrev: 'CAR', score: 1 },
      awayTeam: { id: 6, abbrev: 'BOS', score: 0 },
    }
    mockScoreboardAndPbp({
      liveGames: [liveGame],
      pbpByGameId: {
        '2025020556': {
          periodDescriptor: { number: 1 },
          clock: { inIntermission: true },
          plays: [
            { typeDescKey: 'goal', periodDescriptor: { number: 1 }, details: { eventOwnerTeamId: 12 } },
            { typeDescKey: 'period-end', periodDescriptor: { number: 1 } },
          ],
        },
      },
    })

    await poll(env, makeCtx())
    const ends = sendPushMock.mock.calls.filter(([, payload]) => payload.tag === 'period-end-2025020556-1')
    expect(ends).toHaveLength(1)
    expect(ends[0][1].title).toBe('🔔 End of P1')
    // Tapping it opens the P1 summary in the app, from the alert's team's
    // side (a followed team's game isn't in the favorite's view).
    expect(ends[0][1].url).toBe('/?summary=1&game=2025020556&team=CAR')

    // P2 starting afterwards doesn't send it a second time.
    sendPushMock.mockClear()
    mockScoreboardAndPbp({
      liveGames: [liveGame],
      pbpByGameId: {
        '2025020556': {
          periodDescriptor: { number: 2 },
          plays: [
            { typeDescKey: 'goal', periodDescriptor: { number: 1 }, details: { eventOwnerTeamId: 12 } },
            { typeDescKey: 'period-end', periodDescriptor: { number: 1 } },
            { typeDescKey: 'period-start', periodDescriptor: { number: 2 } },
          ],
        },
      },
    })
    await poll(env, makeCtx())
    const tags = sendPushMock.mock.calls.map(([, payload]) => payload.tag)
    expect(tags).toContain('period-start-2025020556-2')
    expect(tags).not.toContain('period-end-2025020556-1')
  })

  it('sends one power-play push per penalty, even when the feed inserts plays ahead of it', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('CAR', 'https://push.example/car-fan')],
        'push:gamestate:2026020001': { homeScore: 0, awayScore: 0, playCount: 1, started: true, period: 2, goalScorers: {} },
      }),
    })
    const liveGame = {
      id: 2026020001, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 12, abbrev: 'CAR', score: 0 },
      awayTeam: { id: 13, abbrev: 'FLA', score: 0 },
    }
    const play = (eventId, typeDescKey, details = {}, timeInPeriod = '08:00') =>
      ({ eventId, typeDescKey, periodDescriptor: { number: 2 }, timeInPeriod, details })
    const interference = play(635, 'penalty', { eventOwnerTeamId: 13, duration: 2, descKey: 'interference-goalkeeper' }, '08:12')
    const pollWith = async plays => {
      sendPushMock.mockClear()
      mockScoreboardAndPbp({ liveGames: [liveGame], pbpByGameId: { '2026020001': { periodDescriptor: { number: 2 }, plays } } })
      await poll(env, makeCtx())
      return sendPushMock.mock.calls.map(([, payload]) => payload).filter(p => p.title === '⚡ CAR Power Play!')
    }

    const first = await pollWith([play(630, 'faceoff'), interference])
    expect(first).toHaveLength(1)
    expect(first[0].body).toBe('FLA — Goaltender interference · 2 min')
    expect(first[0].tag).toBe('pp-2026020001-635')

    // A late-posted shot lands ahead of the penalty, pushing it past last
    // poll's play count -- it used to be announced again here.
    expect(await pollWith([play(630, 'faceoff'), play(633, 'shot-on-goal'), interference, play(637, 'faceoff')])).toHaveLength(0)

    // The next penalty still goes out.
    const next = await pollWith([
      play(630, 'faceoff'), play(633, 'shot-on-goal'), interference, play(637, 'faceoff'),
      play(643, 'penalty', { eventOwnerTeamId: 13, duration: 2, descKey: 'roughing' }, '08:36'),
    ])
    expect(next.map(p => p.body)).toEqual(['FLA — Roughing · 2 min'])
  })

  it('credits a bench minor to the bench, not the player serving it (2025021237, P1 17:25)', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('BOS', 'https://push.example/bos-fan')],
        'push:gamestate:2025021237': { homeScore: 0, awayScore: 0, playCount: 0, started: true, period: 1, goalScorers: {} },
      }),
    })
    const { game, penaltyPlays, rosterSpots } = game2025021237
    const liveGame = { ...game, gameState: 'LIVE', homeTeam: { ...game.homeTeam, score: 0 }, awayTeam: { ...game.awayTeam, score: 0 } }
    sendPushMock.mockClear()
    mockScoreboardAndPbp({ liveGames: [liveGame], pbpByGameId: {
      '2025021237': { periodDescriptor: { number: 1 }, rosterSpots, plays: [penaltyPlays[0]] },
    } })
    await poll(env, makeCtx())
    const pp = sendPushMock.mock.calls.map(([, payload]) => payload).filter(p => p.title.endsWith('Power Play!'))
    expect(pp.map(p => `${p.title} ${p.body}`)).toEqual([
      '⚡ BOS Power Play! CAR — Bench minor · Delay of game (unsuccessful challenge) · 2 min · served by Taylor Hall',
    ])
  })

  it('sends no power-play push for offsetting penalties, misconducts or penalty shots', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('CAR', 'https://push.example/car-fan'), subFor('FLA', 'https://push.example/fla-fan')],
        'push:gamestate:2026020001': { homeScore: 0, awayScore: 0, playCount: 0, started: true, period: 1, goalScorers: {} },
      }),
    })
    const liveGame = {
      id: 2026020001, gameState: 'LIVE', gameType: 2,
      homeTeam: { id: 12, abbrev: 'CAR', score: 0 },
      awayTeam: { id: 13, abbrev: 'FLA', score: 0 },
    }
    const pen = (eventId, teamId, typeCode, duration, descKey, timeInPeriod) => ({
      eventId, typeDescKey: 'penalty', periodDescriptor: { number: 1 }, timeInPeriod,
      details: { eventOwnerTeamId: teamId, typeCode, duration, descKey },
    })
    const plays = []
    const pollWith = async (...added) => {
      plays.push(...added)
      sendPushMock.mockClear()
      mockScoreboardAndPbp({ liveGames: [liveGame], pbpByGameId: { '2026020001': { periodDescriptor: { number: 1 }, plays: [...plays] } } })
      await poll(env, makeCtx())
      return sendPushMock.mock.calls.map(([, payload]) => payload)
        .filter(p => p.title.endsWith('Power Play!')).map(p => `${p.title} ${p.body}`)
    }

    // Fighting majors posted together (CAR-FLA, 2026-09-29, 18:01 of P1).
    expect(await pollWith(
      pen(27, 13, 'MAJ', 5, 'fighting', '18:01'),
      pen(30, 12, 'MAJ', 5, 'fighting', '18:01'),
    )).toEqual([])

    // Matching minors -- the second posting a poll after the first. Only
    // the first half, alone at that point, can go out.
    expect(await pollWith(pen(40, 12, 'MIN', 2, 'slashing', '19:10'))).toEqual(['⚡ FLA Power Play! CAR — Slashing · 2 min'])
    expect(await pollWith(pen(41, 13, 'MIN', 2, 'cross-checking', '19:10'))).toEqual([])

    // Misconduct and penalty shot alone.
    expect(await pollWith(pen(50, 13, 'MIS', 10, 'misconduct', '19:30'))).toEqual([])
    expect(await pollWith(pen(51, 12, 'PS', 0, 'ps-hooking-on-breakaway', '19:40'))).toEqual([])

    // Two minors to one, one to the other: the difference is a power play.
    expect(await pollWith(
      pen(60, 13, 'MIN', 2, 'roughing', '19:50'),
      pen(61, 13, 'MIN', 2, 'roughing', '19:50'),
      pen(62, 12, 'MIN', 2, 'roughing', '19:50'),
    )).toEqual(['⚡ CAR Power Play! FLA — Roughing · 2 min'])
    // ... announced once, even as a further FLA minor at it posts late.
    expect(await pollWith(pen(63, 13, 'MIN', 2, 'unsportsmanlike-conduct', '19:50'))).toEqual([])
  })

  it('dual-broadcasts game-over win/loss for a game involving neither team as this app\'s own default team', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('TOR', 'https://push.example/tor-fan'), subFor('NYR', 'https://push.example/nyr-fan')],
      }),
    })

    const finalGame = {
      id: 2025020777, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-15',
      homeTeam: { id: 10, abbrev: 'TOR', score: 4 },
      awayTeam: { id: 3,  abbrev: 'NYR', score: 2 },
    }
    mockScoreboardAndPbp({ completedGames: [finalGame] })

    await poll(env, makeCtx())

    const calls = sendPushMock.mock.calls
    const torWin  = calls.find(([sub, payload]) => sub.endpoint.includes('tor-fan') && payload.tag?.startsWith('win-'))
    const nyrLoss = calls.find(([sub, payload]) => sub.endpoint.includes('nyr-fan') && payload.tag?.startsWith('final-'))
    expect(torWin?.[1].title).toContain('TOR')
    expect(nyrLoss?.[1].title).toContain('NYR')
    // Tapping either opens that game's summary in the app.
    expect(torWin?.[1].url).toBe('/?summary=game&game=2025020777&team=TOR')
    expect(nyrLoss?.[1].url).toBe('/?summary=game&game=2025020777&team=NYR')
  })

  it('says Final/OT on the loss and (OT) on the win for an overtime game', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({
        'push:subs': [subFor('TOR', 'https://push.example/tor-fan'), subFor('NYR', 'https://push.example/nyr-fan')],
      }),
    })
    mockScoreboardAndPbp({ completedGames: [{
      id: 2025020778, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-15',
      homeTeam: { id: 10, abbrev: 'TOR', score: 3 },
      awayTeam: { id: 3,  abbrev: 'NYR', score: 2 },
      gameOutcome: { lastPeriodType: 'OT' },
    }] })

    await poll(env, makeCtx())

    const titles = sendPushMock.mock.calls.map(([, p]) => p.title)
    expect(titles).toContain('🏆 TOR Win! TOR 3–2 NYR (OT)')
    expect(titles).toContain('Final/OT: NYR 2–3 TOR')
  })

  it('does not call generateGameSummary/AI for a completed game that does not involve CAR', async () => {
    const env = makeEnv({
      VAPID_PRIVATE_KEY: 'fake-key-for-test',
      CACHE: makeFakeCache({ 'push:subs': [] }),
    })
    const finalGame = {
      id: 2025020888, gameState: 'FINAL', gameType: 2, gameDate: '2026-01-16',
      homeTeam: { id: 10, abbrev: 'TOR', score: 4 },
      awayTeam: { id: 3,  abbrev: 'NYR', score: 2 },
    }
    mockScoreboardAndPbp({ completedGames: [finalGame] })

    await poll(env, makeCtx())

    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  // Per-minute cron cost: standings are refetched only once their 5-min
  // cache lapses, and the unread teamstats fetch is gone entirely.
  function polledUrls() {
    return globalThis.fetch.mock.calls.map(([u]) => String(u))
  }

  it('skips the standings fetch while the cached copy is still fresh', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ standings: [{ teamAbbrev: { default: 'CAR' } }] }) })
    mockScoreboardAndPbp({})

    await poll(env, makeCtx())

    expect(polledUrls().some(u => u.includes('/standings/now'))).toBe(false)
  })

  it('fetches standings when the cache is cold, and never fetches team stats', async () => {
    const env = makeEnv({ CACHE: makeFakeCache() })
    mockScoreboardAndPbp({})

    await poll(env, makeCtx())

    expect(polledUrls().some(u => u.includes('/standings/now'))).toBe(true)
    expect(polledUrls().some(u => u.includes('/team/summary'))).toBe(false)
  })

  // Shot map live lag (2026-09-30): the app reads a game as live from its
  // team's cached schedule, which for any team but CAR sat on a 10-minute
  // TTL after the Game Starting push had already gone out.
  describe('scoreboard states on cached schedules', () => {
    const season = () => { const y = new Date().getFullYear() + 2; return `${y - 1}${y}` }
    const schedGame = (gameState, homeScore, awayScore) => ({
      id: 2026020006, gameState,
      homeTeam: { abbrev: 'PHI', ...(homeScore != null && { score: homeScore }) },
      awayTeam: { abbrev: 'PIT', ...(awayScore != null && { score: awayScore }) },
    })
    const live = { id: 2026020006, gameState: 'LIVE', gameType: 2, homeTeam: { id: 4, abbrev: 'PHI', score: 0 }, awayTeam: { id: 5, abbrev: 'PIT', score: 1 } }
    const read = (env, key) => JSON.parse(env.CACHE._store.get(key))

    it('marks a game live on both teams\' cached schedules the tick puck drop shows on the scoreboard', async () => {
      const env = makeEnv({ CACHE: makeFakeCache({
        [`schedule:PIT:${season()}`]: [schedGame('FUT')],
        [`schedule:PHI:${season()}`]: [schedGame('PRE')],
      }) })
      mockScoreboardAndPbp({ liveGames: [live] })

      await poll(env, makeCtx())

      for (const abbr of ['PIT', 'PHI']) {
        const [g] = read(env, `schedule:${abbr}:${season()}`)
        expect(g.gameState).toBe('LIVE')
        expect([g.homeTeam.score, g.awayTeam.score]).toEqual([0, 1])
        expect(g.homeTeam.abbrev).toBe('PHI')
      }
    })

    it('writes no schedule for a team nobody has loaded', async () => {
      const env = makeEnv({ CACHE: makeFakeCache() })
      mockScoreboardAndPbp({ liveGames: [live] })

      await poll(env, makeCtx())

      expect(env.CACHE._store.has(`schedule:PIT:${season()}`)).toBe(false)
    })

    it('keeps the stamp on CAR\'s schedule when the next tick\'s refetch still says FUT', async () => {
      const carLive = { ...live, homeTeam: { id: 12, abbrev: 'CAR', score: 0 } }
      const env = makeEnv({ CACHE: makeFakeCache() })
      mockScoreboardAndPbp({ liveGames: [carLive], scheduleGames: [{ ...schedGame('FUT'), homeTeam: { abbrev: 'CAR' } }] })

      await poll(env, makeCtx())
      await poll(env, makeCtx())

      expect(read(env, `schedule:CAR:${season()}`)[0].gameState).toBe('LIVE')
    })
  })
})

describe('applyScoreboardStates()', () => {
  const g = (gameState, home = 0, away = 0) => ({ id: 1, gameState, homeTeam: { abbrev: 'A', score: home }, awayTeam: { abbrev: 'B', score: away } })
  const states = (gameState, homeScore = 0, awayScore = 0) => ({ 1: { gameState, homeScore, awayScore } })

  it('never moves a game backwards', () => {
    const games = [g('OFF', 3, 2)]
    expect(applyScoreboardStates(games, states('LIVE', 2, 2))).toBe(games)
  })

  it('takes a new score within the same state', () => {
    expect(applyScoreboardStates([g('LIVE', 0, 0)], states('LIVE', 1, 0))[0].homeTeam.score).toBe(1)
  })

  it('returns the same array when nothing changed, and leaves games off the scoreboard alone', () => {
    const games = [g('LIVE', 1, 0), { ...g('FUT'), id: 2 }]
    expect(applyScoreboardStates(games, states('LIVE', 1, 0))).toBe(games)
    expect(applyScoreboardStates(games, null)).toBe(games)
  })

  it('reads scoreboardStates() output', () => {
    const s = scoreboardStates([{ id: 1, gameState: 'CRIT', homeTeam: { score: 2 }, awayTeam: { score: 2 } }])
    expect(applyScoreboardStates([g('FUT')], s)[0]).toMatchObject({ gameState: 'CRIT', homeTeam: { score: 2 }, awayTeam: { score: 2 } })
  })
})

describe('refreshPPUnits()', () => {
  // Every case passes an explicit season. Omitting it is still supported
  // and resolves the current one, but that would put resolveNHLSeason's
  // own upstream call in the middle of these fetch assertions.
  const PP_SEASON = '20252026'

  it('returns a warm pp_units:{season}:{gameType} without re-reading Supabase', async () => {
    const cached = { CAR: { PP: { 1: [8478402] }, PK: {} } }
    const env = makeEnv({ CACHE: makeFakeCache({ [`pp_units:${PP_SEASON}:2`]: cached }) })
    globalThis.fetch = vi.fn()

    expect(await refreshPPUnits(env, { season: PP_SEASON })).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('re-reads Supabase when forced, even with a warm cache', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ [`pp_units:${PP_SEASON}:2`]: { OLD: { PP: {}, PK: {} } } }) })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ team: 'CAR', unit_type: 'PP', unit_number: 1, player_ids: [8478402] }],
    })

    const map = await refreshPPUnits(env, { force: true, season: PP_SEASON })

    expect(map).toEqual({ CAR: { PP: { 1: [8478402] }, PK: {} } })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await env.CACHE.get(`pp_units:${PP_SEASON}:2`))).toEqual(map)
  })

  // The whole reason the key is season-scoped: the shot map can be showing
  // a past season (its off-season fallback, or a season picked from the
  // chips), and the flat pp_units:all key this used to write would hand it
  // the CURRENT season's units to label those games with.
  it('does not serve one season\'s warm cache to another season', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ [`pp_units:${PP_SEASON}:2`]: { CAR: { PP: { 1: [8478402] }, PK: {} } } }) })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ team: 'BOS', unit_type: 'PK', unit_number: 2, player_ids: [8477956] }],
    })

    const map = await refreshPPUnits(env, { season: '20242025' })

    expect(map).toEqual({ BOS: { PP: {}, PK: { 2: [8477956] } } })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain('season=eq.20242025')
    expect(JSON.parse(await env.CACHE.get('pp_units:20242025:2'))).toEqual(map)
  })

  // Units are per game type: a playoff game's PP labels come from the
  // playoff units, which have their own key and query.
  it('reads and caches playoff units separately from the regular season\'s', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ [`pp_units:${PP_SEASON}:2`]: { CAR: { PP: { 1: [1] }, PK: {} } } }) })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ team: 'CAR', unit_type: 'PP', unit_number: 1, player_ids: [8478402] }],
    })

    const map = await refreshPPUnits(env, { season: PP_SEASON, gameType: '3' })

    expect(map).toEqual({ CAR: { PP: { 1: [8478402] }, PK: {} } })
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain(`season=eq.${PP_SEASON}&game_type=eq.3`)
    expect(JSON.parse(await env.CACHE.get(`pp_units:${PP_SEASON}:3`))).toEqual(map)
  })
})

describe('GET /social/test', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/social/test'), env, makeCtx(), new URL('https://example.com/social/test')
    )
    expect(res.status).toBe(401)
  })

  it('returns a preview of the post text without actually posting (no ?post=1)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/social/test?secret=test-poll-secret'), env, makeCtx(),
      new URL('https://example.com/social/test?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.preview).toBe('string')
    expect(body.length).toBe(body.preview.length)
  })
})

describe('POST /push/test', () => {
  it('401s without a matching secret', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/test', { method: 'POST' }), env, makeCtx(), new URL('https://example.com/push/test')
    )
    expect(res.status).toBe(401)
  })

  it('no-ops cleanly when there are no subscribers', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/push/test?secret=test-poll-secret', { method: 'POST' }), env, makeCtx(),
      new URL('https://example.com/push/test?secret=test-poll-secret')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

describe('POST /draft/analyze', () => {
  it('401s without a matching X-Poll-Secret header (not the ?secret= query param convention every other route uses)', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/draft/analyze?secret=test-poll-secret', { method: 'POST', body: { prompt: 'x' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze?secret=test-poll-secret')
    )
    expect(res.status).toBe(401) // query param doesn't count for this route
  })

  it('400s when prompt is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: {}, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(400)
  })

  it('returns the AI analysis on a valid request', async () => {
    const env = makeEnv()
    mockFetchWithAI('Great value pick at this slot.')
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: { prompt: 'Analyze this pick' }, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(200)
    expect((await res.json()).analysis).toBe('Great value pick at this slot.')
  })

  it('502s when the AI response is empty', async () => {
    const env = makeEnv()
    mockFetchWithAI('')
    const res = await handleNHL(
      makeRequest('/draft/analyze', { method: 'POST', body: { prompt: 'Analyze this pick' }, headers: { 'X-Poll-Secret': 'test-poll-secret' } }),
      env, makeCtx(), new URL('https://example.com/draft/analyze')
    )
    expect(res.status).toBe(502)
  })
})

// ── Tier 3 — AI-calling routes (Session 48, Item 2) ──────────────────────
// No secret check on these (see Session 48 findings/decisions — reused
// POLL_SECRET was rejected since these are called from the public
// frontend). Guarded instead by the AI_ROUTE_LIMITER binding (Item 3,
// mocked to always-allow by makeEnv's default here).

describe('GET /prediction/analyze', () => {
  it('returns an error when gameId is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/prediction/analyze'), env, makeCtx(), new URL('https://example.com/prediction/analyze')
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/gameId required/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { gameId: '123', narrative: 'cached narrative' }
    // Team-scoped key (prediction:${gameId}:${team}) -- CAR here since this
    // request doesn't pass ?team=, same as DEFAULT_TEAM_ABBR's fallback.
    const env = makeEnv({ CACHE: { async get(key) { return key === 'prediction:123:CAR' ? JSON.stringify(cached) : null }, async put() {} } })
    mockFetchWithAI('should not be called')
    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )
    expect(await res.json()).toEqual(cached)
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  it('returns an error when the game is not found in the schedule', async () => {
    const env = makeEnv({ CACHE: { async get(key) { return key === 'schedule:CAR:20252026' ? JSON.stringify([]) : null }, async put() {} } })
    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=999'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=999')
    )
    expect((await res.json()).error).toMatch(/not found in schedule/i)
  })

  it('fetches the schedule live and caches it when the cache is cold for a non-default team (regression: "Game not found" in production for every team but CAR)', async () => {
    // CAR's schedule cache stays warm forever via poll()'s own cron
    // refresh; every other team's cache only gets populated by a recent,
    // unrelated /schedule?team=X request -- this route used to just read
    // the cache passively (`kvGet(...) || []`) and error when it was cold,
    // which is the *default* state for every non-CAR team, not an edge
    // case. Confirmed live in production for NJD before this fix.
    const scheduleGames = [
      { id: 456, gameType: 2, gameDate: '2025-10-15', homeTeam: { abbrev: 'NJD' }, awayTeam: { abbrev: 'NYI' } },
    ]
    const standings = [
      { teamAbbrev: { default: 'NJD' }, seasonId: 20252026, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 30, goalAgainst: 30, powerPlayPct: 20, penaltyKillPct: 78, shotsForPerGame: 30, shotsAgainstPerGame: 30 },
      { teamAbbrev: { default: 'NYI' }, seasonId: 20252026, gamesPlayed: 10, wins: 4, losses: 6, otLosses: 0, points: 8, goalFor: 26, goalAgainst: 32, powerPlayPct: 18, penaltyKillPct: 74, shotsForPerGame: 28, shotsAgainstPerGame: 32 },
    ]
    const putCalls = []
    const env = makeEnv({
      CACHE: {
        async get(key) { return key === 'standings' ? JSON.stringify(standings) : null }, // schedule cache cold, like every non-CAR team by default
        async put(key) { putCalls.push(key) },
      },
    })
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: 'NJD take.' } }] }) })
      }
      if (u.includes('club-schedule-season/NJD/20252026')) {
        return Promise.resolve({ ok: true, json: async () => ({ games: scheduleGames }) })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=456&team=NJD'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=456&team=NJD')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.oppAbbr).toBe('NYI')
    expect(body.narrative).toBe('NJD take.')
    expect(putCalls).toContain('schedule:NJD:20252026') // fetched schedule also cached for next time
  })

  it('caches under a team-scoped key, not a bare gameId, so two teams viewing the same game get independently cached/framed responses', async () => {
    // The actual bug reported live: MatchupDetail.jsx's fetch never sent
    // team= at all, so getTeamConfig() always fell back to the default
    // team (CAR) regardless of which team the user had selected --
    // /prediction/analyze then searched CAR's schedule for a game that
    // was never in it, and "Game not found in schedule" fired for every
    // team but CAR, unconditionally (cache warm or not -- the schedule-
    // fetch fix above was necessary but not sufficient on its own). Fixed
    // on both ends: the frontend now sends team=, and this asserts the
    // matching half -- a bare `prediction:${gameId}` key would let
    // whichever team requests a shared game first silently determine the
    // oppAbbr/isHome/carWinPct framing every other team's fans see for
    // that same game, the same class of bug /summary/narrative's own
    // carAbbr-scoped key already guards against.
    const cachedForTor = { gameId: '789', oppAbbr: 'NJD', narrative: 'TOR-framed take' }
    const env = makeEnv({
      CACHE: {
        async get(key) { return key === 'prediction:789:TOR' ? JSON.stringify(cachedForTor) : null },
        async put() {},
      },
    })
    mockFetchWithAI('should not be called')
    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=789&team=TOR'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=789&team=TOR')
    )
    expect(await res.json()).toEqual(cachedForTor)
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  // ── Elo win probability (2026-09) ──────────────────────────────────
  // Regime split: standings pinned to last season -> preseason fallback;
  // real current-season standings -> in-season branch. Both now read the
  // same team_elo_ratings table and share fetchEloRatings()/eloWinProb() --
  // no separate calibration or continuity-dampening step in either regime
  // anymore. See eyewall-pipeline/docs/elo_prediction_model_results.md.

  function mockSupabaseByTable(responses, aiText = 'mock AI response') {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('openrouter.ai')) {
        return Promise.resolve({ ok: true, json: async () => ({ choices: [{ message: { content: aiText } }] }) })
      }
      for (const [match, rows] of Object.entries(responses)) {
        if (u.includes(match)) return Promise.resolve({ ok: true, json: async () => rows })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })
  }

  it('routes to the preseason fallback (Elo, from team_elo_ratings) instead of erroring when standings are still pinned to last season', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    // resolveNHLSeason is mocked to 20252026 above; standings still carrying
    // last season's seasonId is exactly the "NHL's /standings/now hasn't
    // caught up yet" preseason state -- prior season is 20242025.
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20242025, gamesPlayed: 82, points: 90 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: 0.24, shots_for_pg: 28 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 0.2, shots_for_pg: 31 },
      ],
      'team_elo_ratings': [
        { team: 'CAR', rating: 1550 },
        { team: 'BOS', rating: 1480 },
      ],
    }, 'Preseason take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regime).toBe('preseason')
    expect(body.correction).toBe('elo')
    expect(body.isFallback).toBe(true)
    expect(body.dataSeason).toBe(20242025)
    // CAR home (1550+35 home advantage) vs BOS away (1480):
    // 1/(1+10^((1480-1585)/400)) = 0.6850... -> rounds to 65.
    expect(body.carWinPct).toBe(65)
    expect(body.h2hRecord).toMatch(/no games played yet/i)
    expect(body.narrative).toBe('Preseason take.')
    // No team's prediction ever hits both regimes -- the standings-staleness
    // check above is a hard early-return in nhl.js, and this test's own
    // regime: 'preseason' assertion together with the in-season happy-path
    // test's regime: 'in-season' assertion below are mutually exclusive by
    // construction, not just by reading the source.
  })

  it('routes to the preseason fallback when standings are on the current season but neither team has played (Opening Night)', async () => {
    // Real shape of /standings/now on 2026-09-29: seasonId already flipped
    // to the new season, every team at 0 GP. The in-season branch used to
    // render that as "PK%: 0.0%" in the AI prompt.
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20252026, gamesPlayed: 0, wins: 0, losses: 0, otLosses: 0, points: 0, goalFor: 0, goalAgainst: 0 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20252026, gamesPlayed: 0, wins: 0, losses: 0, otLosses: 0, points: 0, goalFor: 0, goalAgainst: 0 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: 0.24, pk_pct: 0.812 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 0.2, pk_pct: 0.79 },
      ],
      'team_elo_ratings': [
        { team: 'CAR', rating: 1550 },
        { team: 'BOS', rating: 1480 },
      ],
    }, 'Preseason take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regime).toBe('preseason')
    expect(body.dataSeason).toBe(20242025)
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    // team_seasons.pp_pct/pk_pct are 0-1 fractions; PP% used to print as "0.2%".
    expect(promptSent).toMatch(/CAR last season \(20242025\): 100 pts, GF\/GA per game: 3\.00 \/ 2\.80, PP%: 24\.0%, PK%: 81\.2%/)
    expect(promptSent).toMatch(/BOS last season \(20242025\): .*PP%: 20\.0%, PK%: 79\.0%/)
    expect(promptSent).not.toMatch(/[^\d.]0\.0%/)
  })
  it('returns an error rather than guessing when neither team has prior-season team_seasons data', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({ 'team_seasons': [] }, 'should not be called')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect((await res.json()).error).toMatch(/no prior-season.*data available/i)
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  it('says "not available" for a missing prior-season pp_pct instead of inventing a value', async () => {
    // pp_pct used to fall back to a hardcoded 22% "league average" here
    // (and to 0 before that). Neither was real data.
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20242025, gamesPlayed: 82, points: 90 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      // CAR's pp_pct is missing entirely -- the UTA-shaped gap
      // (backfill_uta_2025_team_stats.py) this test is modeled on.
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: null, pk_pct: 0.8 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 0.21, pk_pct: 0.78 },
      ],
      'team_elo_ratings': [
        { team: 'CAR', rating: 1520 },
        { team: 'BOS', rating: 1500 },
      ],
    }, 'Preseason take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    // CAR home (1520+35) vs BOS away (1500): 1/(1+10^((1500-1555)/400))
    // = 0.5786... -> rounds to 58.
    expect((await res.json()).carWinPct).toBe(58)
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/CAR last season \(20242025\): 100 pts, GF\/GA per game: 3\.00 \/ 2\.80, PP%: not available, PK%: 80\.0%/)
    expect(promptSent).not.toMatch(/22\.0%|PP%: 0\.0%/)
    expect(promptSent).toMatch(/Don't cite any stat marked "not available"/)
  })

  it('adds a league-average PP%/PK% line computed from every team\'s prior-season row', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20242025, gamesPlayed: 82, points: 100 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20242025, gamesPlayed: 82, points: 90 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    // 32 teams: CAR 0.25/0.85, BOS 0.15/0.75, 30 others at 0.20/0.80 --
    // mean PP% 20.0%, PK% 80.0%.
    const others = Array.from({ length: 30 }, (_, i) => ({ team: `T${i}`, pp_pct: 0.2, pk_pct: 0.8 }))
    mockSupabaseByTable({
      'team_seasons': [
        { team: 'CAR', points: 100, goals_for_pg: 3.0, goals_ag_pg: 2.8, pp_pct: 0.25, pk_pct: 0.85 },
        { team: 'BOS', points: 95, goals_for_pg: 3.1, goals_ag_pg: 2.9, pp_pct: 0.15, pk_pct: 0.75 },
        ...others,
      ],
    }, 'Preseason take.')

    await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/League average \(2024-25, mean of 32 teams\): PP% 20\.0% · PK% 80\.0%/)
  })
  it('does not treat a standings feed with no seasonId as stale (e.g. a test stub)', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 10, wins: 7, losses: 3, otLosses: 0, points: 14, goalFor: 35, goalAgainst: 25, powerPlayPct: 24, penaltyKillPct: 80, shotsForPerGame: 32, shotsAgainstPerGame: 28, streakCode: 'W', streakCount: 3 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 10, wins: 5, losses: 5, otLosses: 0, points: 10, goalFor: 28, goalAgainst: 30, powerPlayPct: 18, penaltyKillPct: 76, shotsForPerGame: 29, shotsAgainstPerGame: 31, streakCode: 'L', streakCount: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockFetchWithAI('CAR should win this one comfortably.', () => Promise.resolve({ ok: true, json: async () => [] }))

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).narrative).toBe('CAR should win this one comfortably.')
  })

  // In-season team_seasons rows: this season (20252026) and last (20242025).
  const tsRow = (team, season, games_played, fields = {}) => ({ team, season, games_played, ...fields })

  it('generates and caches a prediction for a game with standings on both sides, falling back to the SOG-share proxy when team_seasons has no Corsi data', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 40, wins: 25, losses: 15, otLosses: 0, points: 50, goalFor: 140, goalAgainst: 100, streakCode: 'W', streakCount: 3 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 112, goalAgainst: 120, streakCode: 'L', streakCount: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    // No Corsi on either team's rows (e.g. before moneypuck.py's rollup
    // has run) — the route falls back to a shots-on-goal share from
    // team_seasons' shot rates rather than erroring.
    mockSupabaseByTable({
      'team_seasons': [
        tsRow('CAR', 20252026, 40, { shots_for_pg: 32, shots_ag_pg: 28 }),
        tsRow('BOS', 20252026, 40, { shots_for_pg: 29, shots_ag_pg: 31 }),
      ],
      'team_elo_ratings': [{ team: 'CAR', rating: 1600 }, { team: 'BOS', rating: 1400 }],
    }, 'CAR should win this one comfortably.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gameId).toBe('123')
    expect(body.oppAbbr).toBe('BOS')
    expect(body.narrative).toBe('CAR should win this one comfortably.')
    expect(aiCalls(globalThis.fetch)).toHaveLength(1)
    // SOG-share proxy: carCF = carSF/(carSF+oppSA)*100 = 32/(32+31)*100 = 50.8
    expect(body.carCF).toBe('50.8')
    expect(body.corsiForPct).toEqual({ car: 50.8, opp: expect.any(Number) })
    expect(body.corsiCaveat).toMatch(/shots-on-goal share only/i)
    // CAR home (1600+35) vs BOS away (1400): 1/(1+10^((1400-1635)/400))
    // = 0.7910... -> rounds to 79.
    expect(body.carWinPct).toBe(79)
    expect(body.regime).toBe('in-season')
    expect(body.correction).toBe('elo')

    const cached = JSON.parse(await env.CACHE.get('prediction:123:CAR'))
    expect(cached.narrative).toBe('CAR should win this one comfortably.')
  })

  it('reads PP%/PK% from team_seasons and says "not available" when a team has none, instead of 0.0% or a made-up 22%', async () => {
    // The NHL standings feed has no powerPlayPct/penaltyKillPct fields at
    // all -- this route used to read them from there, so every in-season
    // prompt said "PP%: 22.0% · PK%: 0.0%".
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 120, goalAgainst: 120 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 120, goalAgainst: 120 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        tsRow('CAR', 20252026, 40, { pp_pct: null, pk_pct: null }),
        tsRow('BOS', 20252026, 40, { pp_pct: 0.215, pk_pct: 0.784 }),
      ],
    }, 'In-season take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).regime).toBe('in-season')
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/CAR stats:[\s\S]*- PP%: not available\n- PK%: not available/)
    expect(promptSent).toMatch(/BOS stats:[\s\S]*- PP%: 21\.5%\n- PK%: 78\.4%/)
    expect(promptSent).not.toMatch(/22\.0%|[^\d.]0\.0%/)
    // 40 GP clears every blend threshold -- no early-season note.
    expect(promptSent).not.toMatch(/early-season/)
  })

  it('blends an early-season stat with last season\'s by games played and tells the AI it\'s an estimate', async () => {
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 3, wins: 1, losses: 2, otLosses: 0, points: 2, goalFor: 6, goalAgainst: 12 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 3, wins: 2, losses: 1, otLosses: 0, points: 4, goalFor: 9, goalAgainst: 9 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        // CAR: 0-for-3-ish PK so far (66.7%) vs 81.2% last season.
        tsRow('CAR', 20252026, 3, { pk_pct: 0.667 }),
        tsRow('CAR', 20242025, 82, { pk_pct: 0.812, goals_for_pg: 3.5, goals_ag_pg: 2.9 }),
        tsRow('BOS', 20252026, 3, { pk_pct: 0.8 }),
        tsRow('BOS', 20242025, 82, { pk_pct: 0.79, goals_for_pg: 3.0, goals_ag_pg: 3.0 }),
      ],
    }, 'Early take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regime).toBe('in-season')
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    // PK% (k=30): (3*66.7 + 30*81.2) / 33 = 79.88 -> 79.9%
    expect(promptSent).toContain('- PK%: 79.9% early-season estimate (66.7% in 3 GP this season, blended with 81.2% in 2024-25)')
    // GF/GP (k=20): this season 6/3 = 2.00; (3*2.00 + 20*3.50) / 23 = 3.30
    expect(promptSent).toContain('- GF per game: 3.30 early-season estimate (2.00 in 3 GP this season, blended with 3.50 in 2024-25)')
    expect(promptSent).toMatch(/Note: it's early in the season/)
    // Expected score uses the blended rates, not 3 games' worth:
    // CAR GF 3.30 vs BOS GA (3*3.00+20*3.00)/23 = 3.00 -> sqrt(9.9)+0.12 = 3.27 -> 3.3
    expect(body.expCar).toBe(3.3)
  })

  it('stays in-season when only one team has played, showing last season\'s numbers for the team that hasn\'t', async () => {
    const schedule = [
      { id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' },
      // A September exhibition between the same teams -- not head-to-head.
      { id: 9, gameType: 1, homeTeam: { abbrev: 'BOS', score: 2 }, awayTeam: { abbrev: 'CAR', score: 5 }, gameState: 'OFF' },
    ]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 0, wins: 0, losses: 0, otLosses: 0, points: 0, goalFor: 0, goalAgainst: 0 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 1, wins: 1, losses: 0, otLosses: 0, points: 2, goalFor: 4, goalAgainst: 1 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        // A 0-GP row can still carry preseason-game Corsi -- ignored.
        tsRow('CAR', 20252026, 0, { corsi_for_pct_5v5: 0.4 }),
        tsRow('CAR', 20242025, 82, { pk_pct: 0.805, goals_for_pg: 3.55, goals_ag_pg: 2.88, corsi_for_pct_5v5: 0.59 }),
        tsRow('BOS', 20252026, 1, { pk_pct: 1.0, corsi_for_pct_5v5: 0.52 }),
        tsRow('BOS', 20242025, 82, { pk_pct: 0.79, goals_for_pg: 3.0, goals_ag_pg: 3.0, corsi_for_pct_5v5: 0.5 }),
      ],
    }, 'Take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.regime).toBe('in-season')
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toContain('- PK%: 80.5% (2024-25; none this season yet)')
    expect(promptSent).toContain('- GF per game: 3.55 (2024-25; none this season yet)')
    // CAR's 0-GP preseason Corsi (40.0%) is ignored for last season's 59.0%.
    expect(body.carCF).toBe('59.0')
    expect(body.h2hRecord).toBe('no prior meetings')
    expect(promptSent).not.toMatch(/[^\d.]0\.0%/)
  })

  it('fetches standings live when the KV entry has lapsed instead of 404ing', async () => {
    // poll() refills 'standings' only after its 5-min TTL lapses and it
    // next runs; a request in that gap used to get "Team standings not found".
    const schedule = [{ id: 123, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, seasonId: 20252026, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 120, goalAgainst: 120 },
      { teamAbbrev: { default: 'BOS' }, seasonId: 20252026, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 120, goalAgainst: 120 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule }),
    })
    mockSupabaseByTable({ 'standings/now': { standings } }, 'Take.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=123'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=123')
    )

    expect(res.status).toBe(200)
    expect((await res.json()).regime).toBe('in-season')
    expect(JSON.parse(await env.CACHE.get('standings'))).toHaveLength(2)
  })

  it('uses real 5v5 Corsi from team_seasons when both teams have it, instead of the SOG-share proxy', async () => {
    const schedule = [{ id: 124, gameType: 2, homeTeam: { abbrev: 'CAR', score: null }, awayTeam: { abbrev: 'BOS', score: null }, gameState: 'FUT' }]
    const standings = [
      { teamAbbrev: { default: 'CAR' }, gamesPlayed: 40, wins: 25, losses: 15, otLosses: 0, points: 50, goalFor: 140, goalAgainst: 100 },
      { teamAbbrev: { default: 'BOS' }, gamesPlayed: 40, wins: 20, losses: 20, otLosses: 0, points: 40, goalFor: 112, goalAgainst: 120 },
    ]
    const env = makeEnv({
      CACHE: makeFakeCache({ 'schedule:CAR:20252026': schedule, standings }),
    })
    mockSupabaseByTable({
      'team_seasons': [
        tsRow('CAR', 20252026, 40, { corsi_for_pct: 0.55, corsi_for_pct_5v5: 0.592, shots_for_pg: 32, shots_ag_pg: 28 }),
        tsRow('BOS', 20252026, 40, { corsi_for_pct: 0.47, corsi_for_pct_5v5: 0.431, shots_for_pg: 29, shots_ag_pg: 31 }),
      ],
    }, 'CAR has the possession edge.')

    const res = await handleNHL(
      makeRequest('/prediction/analyze?gameId=124'), env, makeCtx(),
      new URL('https://example.com/prediction/analyze?gameId=124')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // 0.592 * 100 = 59.2 (5v5 preferred over all-situations or SOG proxy)
    expect(body.carCF).toBe('59.2')
    expect(body.corsiForPct).toEqual({ car: 59.2, opp: 43.1 })
    expect(body.corsiCaveat).toMatch(/5-on-5 shot-attempt share/i)
  })
})

describe('POST /summary/narrative', () => {
  it('returns an error when gameId or period is missing', async () => {
    const env = makeEnv()
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1', { method: 'POST', body: {} }), env, makeCtx(),
      new URL('https://example.com/summary/narrative?gameId=1')
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/gameId and period required/i)
  })

  it('serves from cache without calling the AI model', async () => {
    const cached = { narrative: 'cached', cardNarrative: null }
    const env = makeEnv({ CACHE: { async get(key) { return key === 'narrative:1:1:CAR' ? JSON.stringify(cached) : null }, async put() {} } })
    mockFetchWithAI('should not be called')
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=1&carAbbr=CAR', { method: 'POST', body: {} }), env, makeCtx(),
      new URL('https://example.com/summary/narrative?gameId=1&period=1&carAbbr=CAR')
    )
    expect(await res.json()).toEqual(cached)
    expect(aiCalls(globalThis.fetch)).toHaveLength(0)
  })

  it('returns an error on invalid JSON body', async () => {
    const env = makeEnv()
    const req = new Request('https://example.com/summary/narrative?gameId=1&period=1', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } })
    const res = await handleNHL(req, env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=1'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid body/i)
  })

  it('502s without caching when the AI returns nothing', async () => {
    const env = makeEnv()
    mockFetchWithAI('')
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=1&carAbbr=CAR', {
        method: 'POST',
        body: { carGoals: 1, oppGoals: 0, corsiForPct: 55, carSOG: 10, oppSOG: 8, carHits: 5, carFOPct: 50, penaltyCount: 2, carPenaltyCount: 1, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=1&carAbbr=CAR')
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/empty/i)
    expect(await env.CACHE.get('narrative:1:1:CAR')).toBeNull()
  })

  it('makes one AI call for a period summary and caches for 30 days', async () => {
    const env = makeEnv()
    mockFetchWithAI('Period summary text.')
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=1&carAbbr=CAR', {
        method: 'POST',
        body: { carGoals: 1, oppGoals: 0, corsiForPct: 55, carSOG: 10, oppSOG: 8, carHits: 5, carFOPct: 50, penaltyCount: 2, carPenaltyCount: 1, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=1&carAbbr=CAR')
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.narrative).toBe('Period summary text.')
    expect(body.cardNarrative).toBeNull()
    expect(aiCalls(globalThis.fetch)).toHaveLength(1)
    expect(JSON.parse(await env.CACHE.get('narrative:1:1:CAR')).narrative).toBe('Period summary text.')
  })

  it('makes two AI calls (narrative + card caption) for a full game summary', async () => {
    const env = makeEnv()
    mockFetchWithAI('Game summary text.')
    const res = await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=game&carAbbr=CAR', {
        method: 'POST',
        body: { carGoals: 3, oppGoals: 1, corsiForPct: 55, carSOG: 30, oppSOG: 22, carHDCF: 10, oppHDCF: 6, carHits: 20, carFOPct: 52, goals: [] },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=game&carAbbr=CAR')
    )

    expect(res.status).toBe(200)
    expect(aiCalls(globalThis.fetch)).toHaveLength(2)
  })

  it('includes each goal\'s period in a full-game prompt, so the model states it instead of guessing', async () => {
    // Regression for a real, confirmed bug: without a period, a side-by-side
    // model comparison found BOTH Gemma and DeepSeek inventing one anyway
    // ("the decisive strike in the third") rather than admitting they didn't
    // know -- see the 2026-09 shared.js model evaluation. The client already
    // sends g.period (PeriodSummary.jsx's statsPayload); this route was
    // simply not reading it.
    const env = makeEnv()
    mockFetchWithAI('Game summary text.')
    await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=game&carAbbr=CAR', {
        method: 'POST',
        body: {
          carGoals: 1, oppGoals: 0, corsiForPct: 55, carSOG: 10, oppSOG: 8, carHits: 5, carFOPct: 50,
          goals: [{ isCar: true, scorerName: 'Sebastian Aho', time: '6:12', period: 2, strength: 'ev' }],
        },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=game&carAbbr=CAR')
    )
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/CAR goal by Sebastian Aho at P2 6:12 \(EV\)/)
  })

  it('omits the period in a single-period prompt, where every goal is already understood to be from that period', async () => {
    const env = makeEnv()
    mockFetchWithAI('Period summary text.')
    await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=2&carAbbr=CAR', {
        method: 'POST',
        body: {
          carGoals: 1, oppGoals: 0, corsiForPct: 55, carSOG: 10, oppSOG: 8, carHits: 5, carFOPct: 50, penaltyCount: 0, carPenaltyCount: 0,
          periodLabel: '2nd Period',
          goals: [{ isCar: true, scorerName: 'Sebastian Aho', time: '6:12', period: 2, strength: 'ev' }],
        },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=2&carAbbr=CAR')
    )
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/CAR goal by Sebastian Aho at 6:12 \(EV\)/)
    expect(promptSent).not.toMatch(/P2 6:12/)
  })

  it('names the goalie in net from carGoalieNames, labelled as the goalie', async () => {
    const env = makeEnv()
    mockFetchWithAI('Period summary text.')
    await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=2&carAbbr=CAR', {
        method: 'POST',
        body: {
          carGoals: 0, oppGoals: 1, corsiForPct: 45, carSOG: 8, oppSOG: 12, carHits: 5, carFOPct: 50, penaltyCount: 0, carPenaltyCount: 0,
          periodLabel: '2nd Period', carGoalieNames: ['Frederik Andersen', 'Pyotr Kochetkov'], goals: [],
        },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=2&carAbbr=CAR')
    )
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).toMatch(/CAR goalie in net: Frederik Andersen, then Pyotr Kochetkov/)
    expect(promptSent).toMatch(/Players you may name: Frederik Andersen, Pyotr Kochetkov\./)
  })

  it('ignores the legacy primaryGoalieName, which older clients took from roster order (often the backup)', async () => {
    const env = makeEnv()
    mockFetchWithAI('Period summary text.')
    await handleNHL(
      makeRequest('/summary/narrative?gameId=1&period=2&carAbbr=CAR', {
        method: 'POST',
        body: {
          carGoals: 0, oppGoals: 0, corsiForPct: 50, carSOG: 8, oppSOG: 8, carHits: 5, carFOPct: 50, penaltyCount: 0, carPenaltyCount: 0,
          periodLabel: '2nd Period', primaryGoalieName: 'Pyotr Kochetkov', goals: [],
        },
      }),
      env, makeCtx(), new URL('https://example.com/summary/narrative?gameId=1&period=2&carAbbr=CAR')
    )
    const promptSent = aiPrompt(globalThis.fetch)[0].content
    expect(promptSent).not.toMatch(/Kochetkov/)
    expect(promptSent).not.toMatch(/goalie in net/)
  })
})

describe('oppGoalBody()', () => {
  it('says a team extends a lead it already had', () => {
    expect(oppGoalBody('FLA', 3, 1, 2)).toBe('FLA extends their lead. Time to push back!')
  })
  it('says a team is pulling away at a 3+ goal lead it already had', () => {
    expect(oppGoalBody('FLA', 4, 1, 3)).toBe('FLA is pulling away. Time to push back!')
  })
  it('says a team takes the lead from a tie or from behind', () => {
    expect(oppGoalBody('FLA', 2, 1, 1)).toBe('FLA takes the lead. Time to push back!')
    expect(oppGoalBody('FLA', 3, 2, 1)).toBe('FLA takes the lead. Time to push back!') // two goals in one poll
  })
  it('keeps the tie and still-leading copy', () => {
    expect(oppGoalBody('FLA', 2, 2, 1)).toBe('FLA ties it up — stay sharp!')
    expect(oppGoalBody('FLA', 1, 3, 0)).toBe('Still leading — hold the line!')
  })
})

describe('periodIsOver()', () => {
  const pbpWith = (...plays) => ({ plays })
  const end = n => ({ typeDescKey: 'period-end', periodDescriptor: { number: n } })

  it('is true once the period-end play for that period is in the feed', () => {
    expect(periodIsOver(pbpWith(end(1)), 1, { gameType: 2 }, 1, 0)).toBe(true)
    expect(periodIsOver(pbpWith(end(1)), 2, { gameType: 2 }, 1, 0)).toBe(false)
    expect(periodIsOver(pbpWith(), 1, { gameType: 2 }, 1, 0)).toBe(false)
  })
  it('leaves a period that ends the game to the win/loss push', () => {
    expect(periodIsOver(pbpWith(end(3)), 3, { gameType: 2 }, 3, 2)).toBe(false)
    expect(periodIsOver(pbpWith(end(3), { typeDescKey: 'game-end' }), 3, { gameType: 2 }, 3, 3)).toBe(false)
    expect(periodIsOver(pbpWith(end(4)), 4, { gameType: 2 }, 2, 2)).toBe(true) // OT tied -> shootout
    expect(periodIsOver(pbpWith(end(5)), 5, { gameType: 2 }, 2, 2)).toBe(false) // shootout
  })
  it('sends a tied end of regulation', () => {
    expect(periodIsOver(pbpWith(end(3)), 3, { gameType: 3 }, 2, 2)).toBe(true)
  })
})

describe('scoreboardBroadcasts()', () => {
  it('orders national, away, home and drops duplicate networks', () => {
    expect(scoreboardBroadcasts([
      { network: 'SN-PIT+', market: 'H', countryCode: 'US', sequenceNumber: 374 },
      { network: 'DSN', market: 'A', countryCode: 'US', sequenceNumber: 1 },
      { network: 'NHLN', market: 'N', countryCode: 'US', sequenceNumber: 35 },
      { network: 'NHLN', market: 'N', countryCode: 'US', sequenceNumber: 36 },
    ])).toEqual([
      { network: 'NHLN', market: 'N', countryCode: 'US' },
      { network: 'DSN', market: 'A', countryCode: 'US' },
      { network: 'SN-PIT+', market: 'H', countryCode: 'US' },
    ])
  })
  it('is empty when the feed lists none', () => {
    expect(scoreboardBroadcasts(undefined)).toEqual([])
    expect(scoreboardBroadcasts([])).toEqual([])
  })
})

describe('POST /live-activity/register', () => {
  const token = 'ab'.repeat(32)
  const post = (env, body) => handleNHL(
    makeRequest('/live-activity/register', { method: 'POST', body: JSON.stringify(body) }),
    env, makeCtx(), new URL('https://x/live-activity/register'))

  it('stores a token per game, once', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    await post(env, { gameId: 2025020700, token })
    const res = await post(env, { gameId: 2025020700, token })
    expect(await res.json()).toEqual({ ok: true, count: 1 })
    expect(JSON.parse(await env.CACHE.get('la:tokens:2025020700'))).toEqual([token])
  })

  it('rejects a bad game id or token', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    expect((await post(env, { gameId: 'x', token })).status).toBe(400)
    expect((await post(env, { gameId: 2025020700, token: 'not hex!' })).status).toBe(400)
  })
})

describe('POST /live-activity/start-token', () => {
  const token = 'cd'.repeat(32)
  const post = (env, body) => handleNHL(
    makeRequest('/live-activity/start-token', { method: 'POST', body: JSON.stringify(body) }),
    env, makeCtx(), new URL('https://x/live-activity/start-token'))
  const list = async (env, team) => JSON.parse(await env.CACHE.get(`la:start:${team}`) || '[]')

  it('puts a token on its team once, with its language', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    await post(env, { token, team: 'car', locale: 'fr' })
    const res = await post(env, { token, team: 'CAR', locale: 'fr' })
    expect(await res.json()).toEqual({ ok: true, team: 'CAR' })
    expect(await list(env, 'CAR')).toEqual([{ token, locale: 'fr' }])
  })

  it('moves a token when the favorite changes, and takes it off when turned off', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    await post(env, { token, team: 'CAR' })
    await post(env, { token, team: 'BOS' })
    expect(await list(env, 'CAR')).toEqual([])
    expect(await list(env, 'BOS')).toEqual([{ token, locale: 'en' }])
    await post(env, { token, team: 'BOS', enabled: false })
    expect(await list(env, 'BOS')).toEqual([])
  })

  it('rejects a bad token or a team that isn’t an NHL team', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({}) })
    expect((await post(env, { token: 'nope', team: 'CAR' })).status).toBe(400)
    expect((await post(env, { token, team: 'XYZ' })).status).toBe(400)
  })
})

describe('startLiveActivities()', () => {
  const game = { id: 2026010044, homeTeam: { abbrev: 'CAR' }, awayTeam: { abbrev: 'NSH' } }
  const state = { homeScore: 0, awayScore: 0, periodLabel: '1st', clock: '20:00', inIntermission: false, status: 'live', lastEvent: null, strength: null }
  const a = 'aa'.repeat(32), b = 'bb'.repeat(32), c = 'cc'.repeat(32)

  it('starts each follower’s activity once per game, from either side', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({
      'la:start:CAR': [{ token: a, locale: 'en' }, { token: b, locale: 'fr' }],
      'la:start:NSH': [{ token: c, locale: 'en' }],
    }) })
    sendLiveActivityPushMock.mockClear()
    await startLiveActivities(env, game, state)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(3)
    const [token, opts] = sendLiveActivityPushMock.mock.calls[0]
    expect(token).toBe(a)
    expect(opts).toMatchObject({
      event: 'start', state, attributesType: 'GameActivityAttributes',
      attributes: { gameId: 2026010044, homeAbbr: 'CAR', awayAbbr: 'NSH', homeColor: '#ff0f0f', followAbbr: 'CAR' },
      alert: { title: 'NSH @ CAR' },
    })
    expect(sendLiveActivityPushMock.mock.calls[1][1].alert.body).toMatch(/écran verrouillé/)
    expect(sendLiveActivityPushMock.mock.calls[2][1].attributes.followAbbr).toBe('NSH')

    await startLiveActivities(env, game, state)
    expect(sendLiveActivityPushMock).toHaveBeenCalledTimes(3) // not again next minute
  })

  it('drops a start token Apple says is dead', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'la:start:CAR': [{ token: a, locale: 'en' }, { token: b, locale: 'en' }] }) })
    sendLiveActivityPushMock.mockClear()
    sendLiveActivityPushMock.mockResolvedValueOnce('expired').mockResolvedValueOnce('ok')
    await startLiveActivities(env, game, state)
    expect(JSON.parse(await env.CACHE.get('la:start:CAR'))).toEqual([{ token: b, locale: 'en' }])
  })
})

describe('liveActivityState()', () => {
  const game = { gameType: 2, homeTeam: { id: 12, abbrev: 'CAR', score: 2 }, awayTeam: { id: 13, abbrev: 'FLA', score: 1 } }
  const pbp = {
    periodDescriptor: { number: 2, periodType: 'REG' },
    clock: { timeRemaining: '07:58', inIntermission: false },
    rosterSpots: [{ playerId: 1, lastName: { default: 'Aho' } }, { playerId: 2, lastName: { default: 'Tkachuk' } }],
    plays: [
      { typeDescKey: 'goal', periodDescriptor: { number: 2, periodType: 'REG' }, timeInPeriod: '12:02', situationCode: '1451',
        details: { eventOwnerTeamId: 12, scoringPlayerId: 1, scoringPlayerTotal: 3 } },
      { typeDescKey: 'penalty', periodDescriptor: { number: 2, periodType: 'REG' }, timeInPeriod: '12:30', situationCode: '1451',
        details: { eventOwnerTeamId: 13, committedByPlayerId: 2, duration: 2, descKey: 'high-sticking' } },
    ],
  }

  it('builds the lock-screen state from the scoreboard game and pbp', () => {
    expect(liveActivityState(game, pbp)).toEqual({
      homeScore: 2, awayScore: 1, periodLabel: '2nd', clock: '07:58', inIntermission: false, status: 'live',
      lastEvent: 'PEN · FLA · Tkachuk · High-sticking · 2 min',
      strength: 'CAR PP',
    })
  })

  it('names a goal and labels 5v3, empty nets and playoff OTs', () => {
    const goalOnly = { ...pbp, plays: [{ ...pbp.plays[0], situationCode: '1351' }] }
    expect(liveActivityState(game, goalOnly)).toMatchObject({ lastEvent: 'GOAL · CAR · Aho (3) · 2nd 12:02', strength: 'CAR PP 5v3' })
    const pulled = { ...pbp, plays: [{ typeDescKey: 'faceoff', situationCode: '0651' }] }
    expect(liveActivityState(game, pulled).strength).toBe('FLA 6v5')
    const playoffs = { ...game, gameType: 3 }
    expect(liveActivityState(playoffs, { ...pbp, periodDescriptor: { number: 5, periodType: 'OT' } }).periodLabel).toBe('2OT')
  })

  it('reads a bench minor as the bench’s, served by the player in the box (2025021237, P1 17:25)', () => {
    const { game: real, penaltyPlays, rosterSpots } = game2025021237
    const live = { ...real, homeTeam: { ...real.homeTeam, score: 0 }, awayTeam: { ...real.awayTeam, score: 0 } }
    const at = n => liveActivityState(live, { periodDescriptor: { number: 1, periodType: 'REG' }, rosterSpots, plays: penaltyPlays.slice(0, n) }).lastEvent
    expect(at(1)).toBe('PEN · CAR · Bench minor · Delay of game (unsuccessful challenge) · 2 min · served by Hall')
    expect(at(2)).toBe('PEN · BOS · Kastelic · Goaltender interference · 2 min')
    // No roster: no name at all, never a stand-in.
    expect(liveActivityState(live, { plays: penaltyPlays.slice(0, 1) }).lastEvent)
      .toBe('PEN · CAR · Bench minor · Delay of game (unsuccessful challenge) · 2 min')
  })

  it('skips an impossible situationCode and reads the last real one', () => {
    // CAR-NSH 2026-09-24: a goal coded '1020' read as "CAR 6v5".
    const bad = { ...pbp, plays: [...pbp.plays, { typeDescKey: 'goal', periodDescriptor: { number: 2, periodType: 'REG' }, timeInPeriod: '13:00', situationCode: '1020', details: { eventOwnerTeamId: 13 } }] }
    expect(liveActivityState(game, bad).strength).toBe('CAR PP')
    const onlyBad = { ...pbp, plays: [{ typeDescKey: 'goal', situationCode: '1020', details: { eventOwnerTeamId: 13 } }] }
    expect(liveActivityState(game, onlyBad).strength).toBe(null)
  })

  it('has no strength during an intermission, and final uses how the game ended', () => {
    expect(liveActivityState(game, { ...pbp, clock: { inIntermission: true } }).strength).toBe(null)
    const final = liveActivityState({ ...game, gameOutcome: { lastPeriodType: 'SO' } }, pbp, { final: true })
    expect(final).toMatchObject({ status: 'final', periodLabel: 'SO', strength: null, inIntermission: false })
  })
})
