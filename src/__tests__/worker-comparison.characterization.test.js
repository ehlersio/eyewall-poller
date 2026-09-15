// src/__tests__/worker-comparison.characterization.test.js
// Characterization test for worker.js's GET /config/seasons/comparison,
// written before collapsing its four near-identical per-league blocks (NHL,
// PWHL, AHL, ECHL) into one loop. worker-routes.test.js covers the NHL/PWHL
// "comparable" threshold logic with assertions; this pins the whole
// response for all four leagues, every upstream request in order, and the
// KV write with its TTL, plus each league failing on its own. A refactor
// must leave these snapshots unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'

vi.mock('../seasons.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getAllPWHLSeasons: vi.fn(),
    getAllAHLSeasons: vi.fn(),
    getAllECHLSeasons: vi.fn(),
  }
})

import worker from '../worker.js'
import { getAllPWHLSeasons, getAllAHLSeasons, getAllECHLSeasons } from '../seasons.js'

const teams = (n, season, key = 'season', teamKey = 'team_id', prefix = '') =>
  Array.from({ length: n }, (_, i) => ({ [key]: season, [teamKey]: prefix ? `${prefix}${i}` : i + 1 }))

// Real team maps drive the thresholds: NHL 32, PWHL 12, AHL/ECHL their own
// code-map sizes. A duplicate row per league checks teams are counted once.
const TABLES = {
  team_seasons: [
    ...teams(20, 20262027, 'season', 'team', 'T'),
    ...teams(16, 20232024, 'season', 'team', 'T'),
    { season: 20262027, team: 'T0' },
  ],
  pwhl_team_seasons: [...teams(8, 8, 'season_id'), ...teams(4, 9, 'season_id'), { season_id: 8, team_id: 1 }],
  ahl_team_seasons: [...teams(20, 90, 'season_id'), ...teams(10, 92, 'season_id'), ...teams(3, 88, 'season_id')],
  echl_team_seasons: [...teams(18, 73, 'season_id'), ...teams(5, 76, 'season_id'), { season_id: 73, team_id: 2 }],
}

function installFetch({ failTables = [] } = {}) {
  globalThis.fetch = vi.fn(async (input) => {
    const u = new URL(String(input))
    const table = u.pathname.replace('/rest/v1/', '')
    if (failTables.includes(table)) return { ok: false, status: 503, json: async () => ({}) }
    if (!(table in TABLES)) throw new Error(`unexpected fetch: ${u}`)
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(TABLES[table])) }
  })
}

function makeRecordingEnv(initial = {}) {
  const cache = makeFakeCache(initial)
  const kvWrites = []
  const put = cache.put
  cache.put = async (key, value, opts) => { kvWrites.push({ key, ttl: opts?.expirationTtl ?? null }); return put(key, value) }
  return { env: makeEnv({ CACHE: cache }), kvWrites }
}

async function getComparison(env) {
  const res = await worker.fetch(makeRequest('/config/seasons/comparison'), env, makeCtx())
  return { status: res.status, body: await res.json() }
}

const upstream = () => globalThis.fetch.mock.calls.map(([u]) => String(u))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  getAllPWHLSeasons.mockReset().mockResolvedValue([
    { seasonId: 8, seasonType: 'regular', startYear: 2025 },
    { seasonId: 9, seasonType: 'playoffs', startYear: 2025 },
  ])
  getAllAHLSeasons.mockReset().mockResolvedValue([
    { seasonId: 90, seasonType: 'regular', startYear: 2025 },
    { seasonId: 92, seasonType: 'playoffs', startYear: 2025 },
  ])
  getAllECHLSeasons.mockReset().mockResolvedValue([{ seasonId: 73, seasonType: 'regular', startYear: 2025 }])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /config/seasons/comparison', () => {
  it('all four leagues: response, upstream requests and KV write', async () => {
    installFetch()
    const { env, kvWrites } = makeRecordingEnv()
    expect({ ...(await getComparison(env)), upstream: upstream(), kvWrites }).toMatchSnapshot()
  })

  it('a cached result is served without any upstream request', async () => {
    installFetch()
    const cachedResult = { nhl: { activeTeamCount: 32, seasons: [] } }
    const { env, kvWrites } = makeRecordingEnv({ 'config:seasons:comparison': cachedResult })
    expect(await getComparison(env)).toEqual({ status: 200, body: cachedResult })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(kvWrites).toEqual([])
  })

  it.each(['team_seasons', 'pwhl_team_seasons', 'ahl_team_seasons', 'echl_team_seasons'])(
    'only that league empties when %s fails',
    async (table) => {
      installFetch({ failTables: [table] })
      const { env, kvWrites } = makeRecordingEnv()
      const { status, body } = await getComparison(env)
      const counts = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v.seasons.length]))
      expect({ status, counts, kvWrites }).toMatchSnapshot()
    }
  )

  it('missing season metadata leaves seasonType/startYear null', async () => {
    installFetch()
    getAllPWHLSeasons.mockResolvedValue(null)
    getAllAHLSeasons.mockResolvedValue(null)
    getAllECHLSeasons.mockResolvedValue([])
    const { env } = makeRecordingEnv()
    const { body } = await getComparison(env)
    expect({ pwhl: body.pwhl, ahl: body.ahl, echl: body.echl }).toMatchSnapshot()
  })

  it('a season-metadata lookup that throws empties only that league', async () => {
    installFetch()
    getAllAHLSeasons.mockRejectedValue(new Error('HockeyTech down'))
    const { env } = makeRecordingEnv()
    const { body } = await getComparison(env)
    expect(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v.seasons.length]))).toMatchSnapshot()
  })
})
