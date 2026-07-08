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
}))
vi.mock('../nhl.js', () => ({
  handleNHL: vi.fn().mockResolvedValue(new Response('nhl-handler-called')),
  poll: vi.fn(),
  refreshPPUnits: vi.fn(),
}))
vi.mock('../pwhl.js', () => ({
  handlePWHL: vi.fn().mockResolvedValue(new Response('pwhl-handler-called')),
  pollPWHL: vi.fn(),
}))

import worker from '../worker.js'
import { handleNHL } from '../nhl.js'
import { handlePWHL } from '../pwhl.js'
import { getSeasonsConfig, getAllPWHLSeasonTypes } from '../seasons.js'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

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
