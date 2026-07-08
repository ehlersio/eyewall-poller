// src/__tests__/pwhl-routes.test.js
// Route-level tests for a first slice of handlePWHL's ~20 routes (Session
// 47, Item 2 — audit #9), demonstrating the same harness works across
// both route files. /pwhl/standings covers a cache hit, the 502-on-
// upstream-failure path, and the L10/streak enrichment logic together
// with the raw Supabase read. The remaining ~19 PWHL routes follow one of
// two shapes already covered here or in nhl-routes.test.js (plain
// read-proxy, or protected mutating route) and are mechanical to extend.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
}))

import { handlePWHL } from '../pwhl.js'

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('GET /pwhl/standings', () => {
  it('serves from KV cache without hitting Supabase', async () => {
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify([{ team_id: 1 }]) }, async put() {} } })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 1 }])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('enriches standings with L10/streak from the game log on a cache miss', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 1, points: 40 }] })
      }
      // pwhl_game_log — one win for team 1 vs team 2
      return Promise.resolve({
        ok: true,
        json: async () => [{ game_id: 1, home_team_id: 1, away_team_id: 2, home_score: 3, away_score: 1 }],
      })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    const body = await res.json()
    expect(body[0]).toMatchObject({ team_id: 1, l10W: 1, l10L: 0, streakType: 'W', streakCount: 1 })
  })

  it('returns 502 when the standings fetch itself fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(502)
  })

  it('degrades gracefully (no L10/streak) if only the game-log fetch fails', async () => {
    const env = makeEnv()
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('pwhl_team_seasons')) {
        return Promise.resolve({ ok: true, json: async () => [{ team_id: 1, points: 40 }] })
      }
      return Promise.resolve({ ok: false, status: 500 })
    })

    const res = await handlePWHL(
      makeRequest('/pwhl/standings?season=8'), env, makeCtx(),
      new URL('https://example.com/pwhl/standings?season=8')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ team_id: 1, points: 40 }])
  })
})
