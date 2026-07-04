// src/__tests__/seasons.test.js
// Unit tests for seasons.js — the live NHL/PWHL season resolver.
//
// Scope note: these test the resolution LOGIC (fallback behavior, the
// manual override, and the "reject a hidden/empty candidate season" rule)
// with fetch and KV mocked. They do NOT spin up a real Workers runtime
// (Miniflare/@cloudflare/vitest-pool-workers) — seasons.js's own code
// never touches Workers-specific APIs directly, only `fetch` and the
// imported kvGet/kvPut, so mocking at that boundary gives full coverage
// of the actual drift risk without that extra setup cost.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../shared.js', () => ({
  kvGet: vi.fn(),
  kvPut: vi.fn(),
  HT_BASE: 'https://lscluster.hockeytech.com/feed/index.php',
  HT_KEY: 'test-key',
  HT_HDR: {},
  unwrapJsonp: (text) => JSON.parse(text.trim().replace(/^\(/, '').replace(/\)$/, '')),
}))

import { kvGet, kvPut } from '../shared.js'
import {
  resolveNHLSeason,
  resolvePWHLSeason,
  deriveSeasonType,
  deriveStartYear,
} from '../seasons.js'

// seasons.js never touches env.CACHE directly — only via the mocked
// kvGet/kvPut above — so an empty object is a sufficient stand-in for env.
const env = {}

beforeEach(() => {
  kvGet.mockReset()
  kvPut.mockReset()
  globalThis.fetch = vi.fn()
})

// ── deriveSeasonType ──────────────────────────────────────────
describe('deriveSeasonType', () => {
  it('detects playoffs', () => {
    expect(deriveSeasonType('2026 Playoffs')).toBe('playoffs')
  })

  it('detects preseason', () => {
    expect(deriveSeasonType('2026-27 Preseason')).toBe('preseason')
  })

  it('detects showcase', () => {
    expect(deriveSeasonType('2024 Showcase')).toBe('showcase')
  })

  it('defaults to regular for a normal season name', () => {
    expect(deriveSeasonType('2025-26 Regular Season')).toBe('regular')
  })

  it('defaults to regular for missing/undefined name rather than throwing', () => {
    expect(deriveSeasonType(undefined)).toBe('regular')
  })
})

// ── deriveStartYear ───────────────────────────────────────────
describe('deriveStartYear', () => {
  it('derives the year from start_date when present', () => {
    expect(deriveStartYear('2025-11-01', 'anything')).toBe(2025)
  })

  it('falls back to parsing a leading year out of the name', () => {
    expect(deriveStartYear(null, '2025-26 Regular Season')).toBe(2025)
  })

  it('falls back to the hardcoded default if neither is usable', () => {
    expect(deriveStartYear(null, null)).toBe(2025) // FALLBACK_PWHL.startYear
  })
})

// ── resolveNHLSeason ──────────────────────────────────────────
describe('resolveNHLSeason', () => {
  it('returns the manual override without fetching', async () => {
    kvGet.mockImplementation((_env, key) =>
      Promise.resolve(key === 'config:season:nhl:override' ? '20999999' : null)
    )
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20999999')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns the cached value without fetching', async () => {
    kvGet.mockImplementation((_env, key) => {
      if (key === 'config:season:nhl') return Promise.resolve({ seasonId: '20242025' })
      return Promise.resolve(null)
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20242025')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('accepts a live candidate when games have actually been played', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        standings: [
          { seasonId: '20252026', gamesPlayed: 82 },
          { seasonId: '20252026', gamesPlayed: 81 },
        ],
      }),
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20252026')
    expect(kvPut).toHaveBeenCalledWith(
      env,
      'config:season:nhl',
      expect.objectContaining({ seasonId: '20252026', source: 'live' }),
      expect.any(Number)
    )
  })

  it('rejects a candidate season with zero games played (the pre-season-gap case) and uses the fallback', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ standings: [{ seasonId: '20262027', gamesPlayed: 0 }] }),
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20252026') // FALLBACK_NHL_SEASON, not the empty new season
    expect(kvPut).not.toHaveBeenCalled()
  })

  it('falls back gracefully on a non-OK HTTP response', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: false, status: 500 })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20252026')
  })

  it('falls back gracefully when fetch throws entirely', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20252026')
  })
})

// ── resolvePWHLSeason ─────────────────────────────────────────
describe('resolvePWHLSeason', () => {
  it('returns the manual override without fetching', async () => {
    const override = { seasonId: 999, seasonType: 'regular', startYear: 2099 }
    kvGet.mockImplementation((_env, key) =>
      Promise.resolve(key === 'config:season:pwhl:override' ? override : null)
    )
    const result = await resolvePWHLSeason(env)
    expect(result).toEqual(override)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns the cached value without fetching', async () => {
    const cached = { seasonId: 8, seasonType: 'regular', startYear: 2025 }
    kvGet.mockImplementation((_env, key) =>
      Promise.resolve(key === 'config:season:pwhl' ? cached : null)
    )
    const result = await resolvePWHLSeason(env)
    expect(result).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('accepts current_season_id directly when it is not hidden from standings', async () => {
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '8',
      seasons: [
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-01', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(8)
    expect(result.seasonType).toBe('regular')
    expect(result.startYear).toBe(2025)
  })

  it('rejects a hidden current_season_id and falls back to the most recent non-hidden season — the real 2026-07 case', async () => {
    // Mirrors the actual bootstrap response observed 2026-07-04:
    // current_season_id pointed at a not-yet-started preseason
    // (hide_in_standings: true), and the correct answer was the most
    // recent real season instead (2026 Playoffs).
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '10',
      seasons: [
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-01', hide_in_standings: false },
        { id: '9', name: '2026 Playoffs', start_date: '2026-05-01', hide_in_standings: false },
        { id: '10', name: '2026-27 Preseason', start_date: '2026-09-01', hide_in_standings: true },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(9)
    expect(result.seasonType).toBe('playoffs')
    expect(result.startYear).toBe(2026)
  })

  it('calls the bootstrap endpoint with feed=statviewfeed, not feed=modulekit', async () => {
    // Regression test for a real bug: feed=modulekit returns a 200 OK with
    // no seasons/teams data at all (a bogus {"SiteKit":{"Undefined":
    // "Undefined Tab bootstrap"}} shape), which silently fell through to
    // FALLBACK_PWHL every time without ever throwing — masked because the
    // fallback happened to look plausible. Confirmed via a real captured
    // DevTools request against thepwhl.com on 2026-07-05.
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({
      ok: true,
      text: async () => `({"current_season_id":"8","seasons":[{"id":"8","name":"2025-26 Regular Season","start_date":"2025-11-01","hide_in_standings":false}]})`,
    })
    await resolvePWHLSeason(env)
    const calledUrl = globalThis.fetch.mock.calls[0][0]
    expect(calledUrl).toContain('feed=statviewfeed')
    expect(calledUrl).not.toContain('feed=modulekit')
  })

  it('resolves the real 2026-07-05 production bootstrap payload to season 9, not the fallback', async () => {
    // Fixture built from an actual captured response (docs/hockeytech-api-notes.md).
    // current_season_id "10" (2026-27 Pre-Season) is hidden; the most recent
    // non-hidden season is "9" (2026 Playoffs, start_date 2026-04-28) — NOT
    // "8" (2025-26 Regular Season, start_date 2025-11-21), even though "8"
    // is what FALLBACK_PWHL happens to also equal. This test only passes
    // if resolution actually ran against real data rather than silently
    // hitting the fallback — which is exactly the bug this fixture caught.
    kvGet.mockResolvedValue(null)
    const realBootstrapPayload = {
      current_season_id: '10',
      seasons: [
        { id: '10', name: '2026-27 Pre-Season', start_date: '2026-10-01', hide_in_standings: true },
        { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
        { id: '7', name: '2025-26 Preseason', start_date: '2025-06-01', hide_in_standings: true },
        { id: '6', name: '2025 Playoffs', start_date: '2025-05-06', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(realBootstrapPayload)})` })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(9)
    expect(result.seasonType).toBe('playoffs')
    expect(result.startYear).toBe(2026)
  })

  it('falls back gracefully when bootstrap has no usable season at all', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({
      ok: true,
      text: async () => `({"current_season_id":"99","seasons":[]})`,
    })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(8) // FALLBACK_PWHL
  })

  it('falls back gracefully on a non-OK HTTP response', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: false, status: 502 })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(8)
  })

  it('falls back gracefully when fetch throws entirely', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(8)
  })
})
