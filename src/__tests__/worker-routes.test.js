// src/__tests__/worker-routes.test.js
// Route-level tests for worker.js's dispatcher (Session 47, Item 2 — audit
// #9). Before this, no test constructed a Request/env/ctx and invoked the
// exported `fetch` handler at all -- worker.js's own two routes
// (/config/seasons, /config/seasons/pwhl-types) and its /pwhl/* vs
// everything-else dispatch had zero coverage.
//
// seasons.js is mocked at the module boundary (same approach
// seasons.test.js documents for shared.js) since its own resolution logic
// already has dedicated regression coverage there -- these tests only need
// to confirm worker.js calls the right function and shapes the response
// correctly, not re-verify season resolution itself.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../seasons.js', () => ({
  getSeasonsConfig: vi.fn(),
  refreshSeasonsCache: vi.fn(),
  getAllPWHLSeasonTypes: vi.fn(),
  resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
}))
vi.mock('../nhl.js', () => ({
  handleNHL: vi.fn().mockResolvedValue(new Response('nhl-handler-called')),
  poll: vi.fn(),
  refreshPPUnits: vi.fn(),
}))
vi.mock('../pwhl.js', async () => {
  const actual = await vi.importActual('../pwhl.js')
  return {
    handlePWHL: vi.fn().mockResolvedValue(new Response('pwhl-handler-called')),
    pollPWHL: vi.fn(),
    PWHL_TEAM_CODES: actual.PWHL_TEAM_CODES,
  }
})

import worker from '../worker.js'
import { handleNHL } from '../nhl.js'
import { handlePWHL } from '../pwhl.js'
import { getSeasonsConfig, getAllPWHLSeasonTypes } from '../seasons.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('OPTIONS preflight', () => {
  it('returns 204 with CORS headers for any path', async () => {
    const res = await worker.fetch(makeRequest('/anything', { method: 'OPTIONS' }), makeEnv(), makeCtx())
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

describe('GET /config/seasons', () => {
  it('returns the resolved config as JSON', async () => {
    getSeasonsConfig.mockResolvedValue({ nhl: { seasonId: 20252026 }, pwhl: { seasonId: 8 } })

    const res = await worker.fetch(makeRequest('/config/seasons'), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ nhl: { seasonId: 20252026 }, pwhl: { seasonId: 8 } })
  })
})

describe('GET /config/seasons/pwhl-types', () => {
  it('returns the id->type map as JSON when available', async () => {
    getAllPWHLSeasonTypes.mockResolvedValue({ '8': 'regular', '9': 'playoffs' })

    const res = await worker.fetch(makeRequest('/config/seasons/pwhl-types'), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ '8': 'regular', '9': 'playoffs' })
  })

  it('returns 502 when the bootstrap fetch fails (null, not a guess)', async () => {
    getAllPWHLSeasonTypes.mockResolvedValue(null)

    const res = await worker.fetch(makeRequest('/config/seasons/pwhl-types'), makeEnv(), makeCtx())

    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/unavailable/i)
  })
})

describe('GET /players-search-index', () => {
  function mockSupabaseFetch({ players, teamRows, pwhlRows }) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/rest/v1/players?')) {
        return Promise.resolve({ ok: true, json: async () => players })
      }
      if (u.includes('/rest/v1/player_seasons?')) {
        return Promise.resolve({ ok: true, json: async () => teamRows })
      }
      if (u.includes('/rest/v1/pwhl_players?')) {
        return Promise.resolve({ ok: true, json: async () => pwhlRows })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
  }

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedIndex = [{ id: 1, name: 'Cached Player', team: 'CAR', position: 'C', sport: 'nhl' }]
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedIndex) }, async put() {} } })

    const res = await worker.fetch(makeRequest('/players-search-index'), env, makeCtx())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedIndex)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('joins NHL players with their most-recently-updated current-season team, unions PWHL, and caches the result', async () => {
    mockSupabaseFetch({
      players: [
        { id: 1, name: 'Sebastian Aho', position: 'C' },
        { id: 2, name: 'Retired Guy', position: 'D' }, // no current-season row -> team null
      ],
      teamRows: [
        // player 1 traded mid-season: two team-stint rows: NYR is the more
        // recently updated (still-live) one, CAR has gone stale
        { player_id: 1, team: 'NYR', updated_at: '2026-03-01T00:00:00Z' },
        { player_id: 1, team: 'CAR', updated_at: '2026-01-01T00:00:00Z' },
      ],
      pwhlRows: [
        { player_id: 100, first_name: 'Marie-Philip', last_name: 'Poulin', position: 'F', team_id: 2 },
        { player_id: 101, first_name: null, last_name: null, position: null, team_id: null }, // no name -> filtered out
      ],
    })

    const env = makeEnv()
    const res = await worker.fetch(makeRequest('/players-search-index'), env, makeCtx())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([
      { id: 1, name: 'Sebastian Aho', team: 'NYR', position: 'C', sport: 'nhl' },
      { id: 2, name: 'Retired Guy', team: null, position: 'D', sport: 'nhl' },
      { id: 100, name: 'Marie-Philip Poulin', team: 'MIN', position: 'F', sport: 'pwhl' },
    ])

    const cached = await env.CACHE.get('players-search-index')
    expect(JSON.parse(cached)).toEqual(body)
  })

  it('returns 502 when the NHL players fetch fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })

    const res = await worker.fetch(makeRequest('/players-search-index'), makeEnv(), makeCtx())

    expect(res.status).toBe(502)
  })
})

describe('routing', () => {
  it('dispatches /pwhl/* paths to handlePWHL', async () => {
    await worker.fetch(makeRequest('/pwhl/standings'), makeEnv(), makeCtx())
    expect(handlePWHL).toHaveBeenCalledTimes(1)
    expect(handleNHL).not.toHaveBeenCalled()
  })

  it('dispatches every other path to handleNHL', async () => {
    await worker.fetch(makeRequest('/health'), makeEnv(), makeCtx())
    expect(handleNHL).toHaveBeenCalledTimes(1)
    expect(handlePWHL).not.toHaveBeenCalled()
  })
})
