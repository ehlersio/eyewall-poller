// src/__tests__/edge.test.js
// GET /nhl/edge/(skater|goalie)/:playerId/:season/:gameType (edge.js):
// the trimming of the NHL's EDGE payloads, and the route's 404-vs-502 and
// cache rules. Payloads are cut down from real api-web responses
// (McDavid and Blackwood, 2025-26 regular season, fetched 2026-10-01).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeCache } from './route-harness.js'
import {
  handleEdge, skaterMetrics, goalieMetrics, goalieAreas, measured, counted,
  TTL_CURRENT, TTL_PAST, TTL_NONE_CURRENT, TTL_NONE_PAST,
} from '../edge.js'

const skaterDetail = {
  player: { id: 8478402, gamesPlayed: 82 },
  topShotSpeed: { imperial: 82.05, metric: 132.0467, percentile: 0.3098, leagueAvg: { imperial: 83.6208, metric: 134.5747 }, overlay: {} },
  skatingSpeed: {
    speedMax: { imperial: 24.6119, metric: 39.6089, percentile: 0.9967, leagueAvg: { imperial: 22.1684, metric: 35.6765 } },
    burstsOver20: { value: 681, percentile: 1.0, leagueAvg: { value: 75.2 } },
  },
  sogSummary: [
    { locationCode: 'all', shots: 306, shotsPercentile: 0.9984, shotsLeagueAvg: 85.9138 },
    { locationCode: 'high', shots: 121, shotsPercentile: 0.99, shotsLeagueAvg: 30.1 },
  ],
  zoneTimeDetails: {
    offensiveZonePctg: 0.47687929, offensiveZonePercentile: 0.9788, offensiveZoneLeagueAvg: 0.4308,
    offensiveZoneEvPctg: 0.45271129, offensiveZoneEvPercentile: 0.9694117647059, offensiveZoneEvLeagueAvg: 0.42022407,
  },
}
const skaterShotSpeed = {
  shotSpeedDetails: { avgShotSpeed: { imperial: 48.3919, metric: 77.8792, percentile: 0.2574, leagueAvg: { imperial: 53.1912, metric: 85.603 } } },
}
const skaterDistance = {
  skatingDistanceDetails: [
    { strengthCode: 'all', distancePer60: { imperial: 10.5136, metric: 16.9192, percentile: 0.9929, leagueAvg: { imperial: 9.6011, metric: 15.4507 } } },
    { strengthCode: 'es', distancePer60: { imperial: 9, metric: 14.5, percentile: 0.5, leagueAvg: { imperial: 9, metric: 14.5 } } },
  ],
}
const goalieDetail = {
  player: { id: 8478406, gamesPlayed: 39 },
  stats: { gamesAbove900: { value: 0.6111, percentile: 0.8644, leagueAvg: 0.4901 } },
  shotLocationSummary: [
    { locationCode: 'all', savePctg: 0.903537, savePctgPercentile: 0.678, savePctgLeagueAvg: 0.89585 },
    { locationCode: 'long', savePctg: 0.981, savePctgPercentile: 0.61, savePctgLeagueAvg: 0.975 },
  ],
}
const goalieShotLocation = {
  shotLocationDetails: [
    { area: 'Low Slot', shotsAgainst: 240, saves: 204, goalsAgainst: 36, savePctg: 0.85, savePctgPercentile: 0.6102 },
    { area: 'L Corner', shotsAgainst: 0, saves: 0, goalsAgainst: 0, savePctg: null, savePctgPercentile: null },
  ],
  shotLocationTotals: [],
}
const goalie5v5 = {
  savePctg5v5Details: { savePctgClose: { value: 0.9101, leagueAvg: 0.909512, percentile: 0.4746 } },
}

describe('metric trimming', () => {
  it('keeps both unit systems, the percentile as 0-100 and the league average', () => {
    expect(measured(skaterDetail.skatingSpeed.speedMax)).toEqual({
      imperial: 24.6119, metric: 39.6089, pct: 100, avg: { imperial: 22.1684, metric: 35.6765 },
    })
    expect(counted(skaterDetail.skatingSpeed.burstsOver20)).toEqual({ value: 681, pct: 100, avg: 75.2 })
    expect(counted(goalieDetail.stats.gamesAbove900)).toEqual({ value: 0.6111, pct: 86, avg: 0.4901 })
  })

  it('maps a skater', () => {
    expect(skaterMetrics(skaterDetail, skaterShotSpeed, skaterDistance)).toEqual({
      topSpeed: { imperial: 24.6119, metric: 39.6089, pct: 100, avg: { imperial: 22.1684, metric: 35.6765 } },
      burstsOver20: { value: 681, pct: 100, avg: 75.2 },
      distancePer60: { imperial: 10.5136, metric: 16.9192, pct: 99, avg: { imperial: 9.6011, metric: 15.4507 } },
      topShotSpeed: { imperial: 82.05, metric: 132.0467, pct: 31, avg: { imperial: 83.6208, metric: 134.5747 } },
      avgShotSpeed: { imperial: 48.3919, metric: 77.8792, pct: 26, avg: { imperial: 53.1912, metric: 85.603 } },
      highDangerShots: { value: 121, pct: 99, avg: 30.1 },
      offensiveZoneTimeEv: { value: 0.45271129, pct: 97, avg: 0.42022407 },
    })
  })

  it('maps a goalie', () => {
    expect(goalieMetrics(goalieDetail, goalie5v5)).toEqual({
      gamesAbove900Pct: { value: 0.6111, pct: 86, avg: 0.4901 },
      savePctg5v5Close: { value: 0.9101, pct: 47, avg: 0.909512 },
      longRangeSavePctg: { value: 0.981, pct: 61, avg: 0.975 },
    })
  })

  it('maps a goalie\'s record in each shot area', () => {
    expect(goalieAreas(goalieShotLocation)).toEqual({
      'Low Slot': { shots: 240, goals: 36, savePctg: 0.85, pct: 61 },
      // no shots from there: no save %, no percentile -- never a made-up one
      'L Corner': { shots: 0, goals: 0, savePctg: null, pct: null },
    })
    expect(goalieAreas(null)).toBeNull()
    expect(goalieAreas({ shotLocationDetails: [] })).toBeNull()
  })

  it('leaves a metric null when the payload lacks it, never a default', () => {
    const m = skaterMetrics({ player: {} }, null, null)
    expect(Object.values(m).every(v => v === null)).toBe(true)
    expect(goalieMetrics({}, null)).toEqual({ gamesAbove900Pct: null, savePctg5v5Close: null, longRangeSavePctg: null })
  })
})

const CURRENT = '20262027'
let env
const call = (path) => handleEdge(new Request(`https://w.test${path}`), env, new URL(`https://w.test${path}`))

// routes: { 'skater-detail': body | status }
function mockEdge(routes) {
  globalThis.fetch = vi.fn(async (url) => {
    const name = String(url).match(/\/v1\/edge\/([a-z0-9-]+)\//)?.[1]
    if (!name || !(name in routes)) throw new Error(`unexpected fetch ${url}`)
    const r = routes[name]
    return typeof r === 'number'
      ? new Response('<html>Error</html>', { status: r })
      : new Response(JSON.stringify(r), { status: 200 })
  })
}
const skaterRoutes = {
  'skater-detail': skaterDetail,
  'skater-shot-speed-detail': skaterShotSpeed,
  'skater-skating-distance-detail': skaterDistance,
}

describe('GET /nhl/edge/:kind/:playerId/:season/:gameType', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    env = { CACHE: makeFakeCache({ 'config:season:nhl': { seasonId: CURRENT } }) }
    env.CACHE.put = vi.fn(env.CACHE.put)
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('rejects bad paths without calling the NHL', async () => {
    mockEdge(skaterRoutes)
    for (const p of ['/nhl/edge/skater/8478402/20252026/1', '/nhl/edge/coach/8478402/20252026/2', '/nhl/edge/skater/abc/20252026/2', '/nhl/edge/skater/8478402/2025/2']) {
      expect((await call(p)).status).toBe(400)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('serves a skater, cached 30 days for a past season', async () => {
    mockEdge(skaterRoutes)
    const res = await call('/nhl/edge/skater/8478402/20252026/2')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ available: true, kind: 'skater', playerId: 8478402, season: '20252026', gameType: 2, gamesPlayed: 82 })
    expect(body.metrics.topSpeed.pct).toBe(100)
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_PAST })
    // second call is served from KV
    globalThis.fetch.mockClear()
    expect((await call('/nhl/edge/skater/8478402/20252026/2')).status).toBe(200)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('caches the current season for 6 hours', async () => {
    mockEdge(skaterRoutes)
    await call(`/nhl/edge/skater/8478402/${CURRENT}/2`)
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_CURRENT })
  })

  it('serves a goalie', async () => {
    mockEdge({ 'goalie-detail': goalieDetail, 'goalie-5v5-detail': goalie5v5, 'goalie-shot-location-detail': goalieShotLocation })
    const body = await (await call('/nhl/edge/goalie/8478406/20252026/2')).json()
    expect(body).toMatchObject({ available: true, kind: 'goalie', gamesPlayed: 39 })
    expect(body.metrics.savePctg5v5Close).toEqual({ value: 0.9101, pct: 47, avg: 0.909512 })
    expect(body.areas['Low Slot']).toEqual({ shots: 240, goals: 36, savePctg: 0.85, pct: 61 })
  })

  it('serves a goalie without areas when the NHL has none for him', async () => {
    mockEdge({ 'goalie-detail': goalieDetail, 'goalie-5v5-detail': goalie5v5, 'goalie-shot-location-detail': 404 })
    const body = await (await call('/nhl/edge/goalie/8478406/20252026/2')).json()
    expect(body.available).toBe(true)
    expect(body.areas).toBeNull()
  })

  it('404s, cached, when the NHL has no EDGE data -- a past season for a week', async () => {
    mockEdge({ ...skaterRoutes, 'skater-detail': 404 })
    const res = await call('/nhl/edge/skater/8478402/20202021/2')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ available: false, kind: 'skater', playerId: 8478402, season: '20202021', gameType: 2 })
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_NONE_PAST })
    globalThis.fetch.mockClear()
    expect((await call('/nhl/edge/skater/8478402/20202021/2')).status).toBe(404)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('caches a current-season 404 for an hour, since the next game can bring data', async () => {
    mockEdge({ ...skaterRoutes, 'skater-detail': 404 })
    expect((await call(`/nhl/edge/skater/8478402/${CURRENT}/3`)).status).toBe(404)
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_NONE_CURRENT })
  })

  it('still serves the detail when a secondary endpoint has no data', async () => {
    mockEdge({ ...skaterRoutes, 'skater-shot-speed-detail': 404 })
    const body = await (await call('/nhl/edge/skater/8478402/20252026/2')).json()
    expect(body.available).toBe(true)
    expect(body.metrics.avgShotSpeed).toBeNull()
    expect(body.metrics.topSpeed).not.toBeNull()
  })

  it('502s, uncached, when any NHL call fails', async () => {
    mockEdge({ ...skaterRoutes, 'skater-skating-distance-detail': 503 })
    expect((await call('/nhl/edge/skater/8478402/20252026/2')).status).toBe(502)
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') })
    expect((await call('/nhl/edge/skater/8478402/20252026/2')).status).toBe(502)
    expect(env.CACHE.put).not.toHaveBeenCalled()
  })

  it('is reachable through handleNHL', async () => {
    mockEdge(skaterRoutes)
    const { handleNHL } = await import('../nhl.js')
    const url = new URL('https://w.test/nhl/edge/skater/8478402/20252026/2')
    const res = await handleNHL(new Request(url), env, { waitUntil() {} }, url)
    expect(res.status).toBe(200)
  })
})
