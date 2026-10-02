// src/__tests__/edge.test.js
// GET /nhl/edge/(skater|goalie)/:playerId/:season/:gameType (edge.js):
// the trimming of the NHL's EDGE payloads, and the route's 404-vs-502 and
// cache rules. Payloads are cut down from real api-web responses
// (McDavid and Blackwood, 2025-26 regular season, fetched 2026-10-01).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeCache } from './route-harness.js'
import {
  handleEdge, skaterMetrics, goalieMetrics, goalieAreas, teamMetrics, measured, counted,
  playerIdFromSlug, leaderRow,
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
// Carolina 2025-26 (team-detail), trimmed
const teamDetail = {"team": {"id": 12, "abbrev": "CAR", "gamesPlayed": 82}, "shotSpeed": {"shotAttemptsOver90": {"value": 78, "rank": 7}, "topShotSpeed": {"imperial": 99.4, "metric": 159.9688, "rank": 15, "leagueAvg": {"imperial": 99.6925, "metric": 160.4395}}}, "skatingSpeed": {"burstsOver22": {"value": 103, "rank": 8}, "burstsOver20": {"value": 1787, "rank": 11, "leagueAvg": {"value": 1762}}, "speedMax": {"imperial": 23.5969, "metric": 37.9754, "rank": 22, "leagueAvg": {"imperial": 23.8027, "metric": 38.3066}}}, "distanceSkated": {"total": {"imperial": 3764.1643, "metric": 6057.5396, "rank": 9, "leagueAvg": {"imperial": 3727.0127, "metric": 5997.7528}}}, "sogSummary": [{"locationCode": "all", "shots": 2637, "shotsRank": 2, "shotsLeagueAvg": 2282.25, "shootingPctg": 0.1104, "shootingPctgRank": 18, "shootingPctgLeagueAvg": 0.1107, "goals": 291, "goalsRank": 2, "goalsLeagueAvg": 252.6875}, {"locationCode": "high", "shots": 723, "shotsRank": 2, "shotsLeagueAvg": 648.7813, "shootingPctg": 0.1867, "shootingPctgRank": 20, "shootingPctgLeagueAvg": 0.1941, "goals": 135, "goalsRank": 8, "goalsLeagueAvg": 125.9375}], "zoneTimeDetails": {"offensiveZonePctg": 0.4554579, "offensiveZoneRank": 1, "offensiveZoneLeagueAvg": 0.4154386, "offensiveZoneEvPctg": 0.4551603, "offensiveZoneEvRank": 1, "offensiveZoneEvLeagueAvg": 0.4099338, "neutralZonePctg": 0.1836144, "neutralZoneRank": 4, "neutralZoneLeagueAvg": 0.1691227, "defensiveZonePctg": 0.3609277, "defensiveZoneRank": 1, "defensiveZoneLeagueAvg": 0.4154386}}

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

  it('maps a team, with the NHL\'s rank among the 32 in place of a percentile', () => {
    const m = teamMetrics(teamDetail)
    expect(m.offensiveZoneTime).toEqual({ value: 0.4554579, rank: 1, avg: 0.4154386 })
    // rank 1 is the LEAST defensive-zone time -- the NHL ranks best first
    expect(m.defensiveZoneTime).toEqual({ value: 0.3609277, rank: 1, avg: 0.4154386 })
    expect(m.highDangerShots).toEqual({ value: 723, rank: 2, avg: 648.7813 })
    expect(m.highDangerShootingPctg).toEqual({ value: 0.1867, rank: 20, avg: 0.1941 })
    expect(m.topSpeed).toEqual({ imperial: 23.5969, metric: 37.9754, rank: 22, avg: { imperial: 23.8027, metric: 38.3066 } })
    expect(m.burstsOver20).toEqual({ value: 1787, rank: 11, avg: 1762 })
    // no league average given for this one: null, never made up
    expect(m.burstsOver22).toEqual({ value: 103, rank: 8, avg: null })
    expect(m.shotAttemptsOver90).toEqual({ value: 78, rank: 7, avg: null })
    expect(Object.values(teamMetrics({})).every(v => v === null)).toBe(true)
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

  it('serves a team by its NHL team id', async () => {
    mockEdge({ 'team-detail': teamDetail })
    const res = await call('/nhl/edge/team/12/20252026/2')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ available: true, kind: 'team', teamId: 12, season: '20252026', gameType: 2, gamesPlayed: 82 })
    expect(body.playerId).toBeUndefined()
    expect(body.metrics.offensiveZoneTime.rank).toBe(1)
    expect(globalThis.fetch.mock.calls[0][0]).toContain('/v1/edge/team-detail/12/20252026/2')
  })

  it('404s a team the NHL has no EDGE data for, and 400s a bad team id', async () => {
    mockEdge({ 'team-detail': 404 })
    expect((await call('/nhl/edge/team/12/20202021/2')).status).toBe(404)
    expect((await call('/nhl/edge/team/123/20252026/2')).status).toBe(400)
  })

  it('is reachable through handleNHL', async () => {
    mockEdge(skaterRoutes)
    const { handleNHL } = await import('../nhl.js')
    const url = new URL('https://w.test/nhl/edge/skater/8478402/20252026/2')
    const res = await handleNHL(new Request(url), env, { waitUntil() {} }, url)
    expect(res.status).toBe(200)
  })
})

// Rows cut down from the NHL's 2025-26 top 10s (skater-speed-top-10 etc.)
const speedTop = [{
  player: { firstName: { default: 'Beck' }, lastName: { default: 'Malenstyn' }, slug: 'beck-malenstyn-8479359', headshot: 'h.png', position: 'L', sweaterNumber: 29, team: { abbrev: 'BUF' } },
  maxSpeed: { imperial: 24.9389, metric: 40.1352, overlay: { gameDate: '2026-03-12', awayTeam: { abbrev: 'WSH' }, homeTeam: { abbrev: 'BUF' }, periodDescriptor: { number: 3, periodType: 'REG' }, timeInPeriod: '12:05' } },
  burstsOver22: 14,
}]
const zoneTop = [{
  player: { firstName: { default: 'Shayne' }, lastName: { default: 'Gostisbehere' }, slug: 'shayne-gostisbehere-8476906', position: 'D', team: { abbrev: 'CAR' } },
  offensiveZoneTime: 0.49576938,
}]

describe('EDGE leaders', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    env = { CACHE: makeFakeCache({ 'config:season:nhl': { seasonId: CURRENT } }) }
    env.CACHE.put = vi.fn(env.CACHE.put)
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('reads the player id off the slug -- the top 10s have no id field', () => {
    expect(playerIdFromSlug('beck-malenstyn-8479359')).toBe(8479359)
    expect(playerIdFromSlug('no-id-here')).toBeNull()
    expect(playerIdFromSlug(undefined)).toBeNull()
  })

  it('compacts a speed row with when the NHL clocked it', () => {
    expect(leaderRow(speedTop[0], { field: 'maxSpeed', kind: 'measure', moment: true })).toEqual({
      playerId: 8479359, firstName: 'Beck', lastName: 'Malenstyn', team: 'BUF', position: 'L', headshot: 'h.png',
      imperial: 24.9389, metric: 40.1352,
      moment: { date: '2026-03-12', away: 'WSH', home: 'BUF', period: 3, periodType: 'REG', time: '12:05' },
    })
    expect(leaderRow(zoneTop[0], { field: 'offensiveZoneTime', kind: 'share' })).toMatchObject({ playerId: 8476906, value: 0.49576938 })
    expect(leaderRow({ player: speedTop[0].player }, { field: 'maxSpeed', kind: 'measure' })).toBeNull()
  })

  it('serves all four lists, a missing one as []', async () => {
    mockEdge({ 'skater-speed-top-10': speedTop, 'skater-shot-speed-top-10': 404, 'skater-distance-top-10': [], 'skater-zone-time-top-10': zoneTop })
    const res = await call('/nhl/edge/leaders/20252026/2')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ available: true, kind: 'leaders', season: '20252026', gameType: 2 })
    expect(body.categories.speed[0].playerId).toBe(8479359)
    expect(body.categories.shotSpeed).toEqual([])
    expect(body.categories.offensiveZoneTime[0].value).toBe(0.49576938)
    expect(globalThis.fetch.mock.calls.map(c => String(c[0]))).toContain('https://api-web.nhle.com/v1/edge/skater-speed-top-10/all/max/20252026/2')
    expect(env.CACHE.put.mock.calls[0][2]).toEqual({ expirationTtl: TTL_PAST })
  })

  it('404s, cached, when none of the lists has data', async () => {
    mockEdge({ 'skater-speed-top-10': 404, 'skater-shot-speed-top-10': 404, 'skater-distance-top-10': 404, 'skater-zone-time-top-10': 404 })
    expect((await call('/nhl/edge/leaders/20202021/2')).status).toBe(404)
    expect(env.CACHE.put).toHaveBeenCalled()
  })

  it('502s when the NHL fails, and 400s a bad path', async () => {
    mockEdge({ 'skater-speed-top-10': 503, 'skater-shot-speed-top-10': speedTop, 'skater-distance-top-10': [], 'skater-zone-time-top-10': zoneTop })
    expect((await call('/nhl/edge/leaders/20252026/2')).status).toBe(502)
    expect((await call('/nhl/edge/leaders/2025/2')).status).toBe(400)
  })
})
