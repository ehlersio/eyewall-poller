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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  nextSeasonHasImminentSchedule,
  resolvePWHLSeason,
  getAllPWHLSeasonTypes,
  getAllPWHLSeasons,
  hockeySeasonStartYear,
  pwhlSeasonLabel,
  pwhlSeasonStartYears,
  getAllAHLSeasons,
  getAllECHLSeasons,
  deriveSeasonType,
  seasonNameKey,
  deriveStartYear,
  findPWHLPreseasonFor,
  pickPWHLSeasonContext,
  resolvePWHLSeasonContext,
  getPWHLScheduleSeasonIds,
  getSeasonsConfig,
} from '../seasons.js'

function isoDaysFromNow(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

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

  // HockeyTech named the PWHL's 2026-27 season "2026-27 Pre-Season" where
  // every prior year was one word. Matched on letters only, punctuation
  // can't change the answer -- before this it fell through to 'regular',
  // so from that season's start date the live path would have called the
  // preseason the current regular season.
  it.each([
    '2026-27 Pre-Season',
    '2026-27 Pre Season',
    '2026-27 PRE-SEASON',
  ])('reads %s as preseason whatever its punctuation', (name) => {
    expect(deriveSeasonType(name)).toBe('preseason')
  })

  it('keeps letters only in the key it matches on', () => {
    expect(seasonNameKey('2026-27 Pre-Season')).toBe('preseason')
    expect(seasonNameKey(null)).toBe('')
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

// ── nextSeasonHasImminentSchedule ──────────────────────────────
describe('nextSeasonHasImminentSchedule', () => {
  it('returns true when the first scheduled game is within the lookahead window', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ gameDate: isoDaysFromNow(9) }, { gameDate: isoDaysFromNow(12) }] }),
    })
    const result = await nextSeasonHasImminentSchedule('20262027')
    expect(result).toBe(true)
  })

  it('returns false when the first scheduled game is well beyond the lookahead window', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ gameDate: isoDaysFromNow(90) }] }),
    })
    const result = await nextSeasonHasImminentSchedule('20262027')
    expect(result).toBe(false)
  })

  it('picks the EARLIEST game, not games[0], when the response is unsorted', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        games: [{ gameDate: isoDaysFromNow(90) }, { gameDate: isoDaysFromNow(9) }],
      }),
    })
    const result = await nextSeasonHasImminentSchedule('20262027')
    expect(result).toBe(true)
  })

  it('returns false when the first game is long past -- a season already played is not "next"', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ gameDate: isoDaysFromNow(-365) }, { gameDate: isoDaysFromNow(-200) }] }),
    })
    expect(await nextSeasonHasImminentSchedule('20262027')).toBe(false)
  })

  it('still returns true when the first (preseason) game was a few weeks ago', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ games: [{ gameDate: isoDaysFromNow(-14) }, { gameDate: isoDaysFromNow(20) }] }),
    })
    expect(await nextSeasonHasImminentSchedule('20262027')).toBe(true)
  })

  it('returns false when no schedule has been published yet (empty games array)', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ games: [] }) })
    const result = await nextSeasonHasImminentSchedule('20272028')
    expect(result).toBe(false)
  })

  it('returns false on a non-OK HTTP response, without throwing', async () => {
    globalThis.fetch.mockResolvedValue({ ok: false, status: 404 })
    const result = await nextSeasonHasImminentSchedule('20272028')
    expect(result).toBe(false)
  })

  it('returns false when fetch throws entirely, without throwing', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    const result = await nextSeasonHasImminentSchedule('20272028')
    expect(result).toBe(false)
  })

  it('queries club-schedule-season for the given seasonId', async () => {
    globalThis.fetch.mockResolvedValue({ ok: true, json: async () => ({ games: [] }) })
    await nextSeasonHasImminentSchedule('20262027')
    const calledUrl = globalThis.fetch.mock.calls[0][0]
    expect(calledUrl).toContain('/club-schedule-season/')
    expect(calledUrl).toContain('20262027')
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

  it('rejects a candidate season with zero games played (the pre-season-gap case) and uses the season before it while its schedule is not yet imminent', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ standings: [{ seasonId: '20262027', gamesPlayed: 0 }] }),
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20252026') // the candidate's prior season, not the empty new one
    // Cached for an hour only, so the candidate takes over soon after it's imminent.
    expect(kvPut).toHaveBeenCalledWith(env, 'config:season:nhl', expect.objectContaining({ seasonId: '20252026', source: 'live-prior' }), 3600)
  })

  it('looks ahead to next season once its schedule is imminent, even though standings still only has real data for the season before it', async () => {
    // The actual real-production scenario this look-ahead exists for
    // (found 2026-09-11): standings/now genuinely still only has real
    // 20252026 data (last season, gamesPlayed=82 per team) -- 20262027's
    // preseason hasn't been played yet, so it can't show up in standings
    // at all. Without the look-ahead, this resolves to 20252026 (correct
    // per gamesPlayed, but stale for schedule/roster UI once camp/preseason
    // is genuinely close). club-schedule-season for 20262027 already has
    // CAR's real preseason schedule published, opener 9 days out.
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/standings/now')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ standings: [{ seasonId: '20252026', gamesPlayed: 82 }] }),
        })
      }
      if (url.includes('/club-schedule-season/')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ games: [{ gameDate: isoDaysFromNow(9) }] }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20262027')
    expect(kvPut).toHaveBeenCalledWith(
      env,
      'config:season:nhl',
      expect.objectContaining({ seasonId: '20262027', source: 'live' }),
      expect.any(Number)
    )
  })

  it('a zero-games candidate whose own schedule is imminent becomes current', async () => {
    // The look-ahead is anchored on the standings candidate itself (audit
    // 2026-10-06 Worker F3), not on the fallback seed.
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/standings/now')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ standings: [{ seasonId: '20262027', gamesPlayed: 0 }] }),
        })
      }
      if (url.includes('/club-schedule-season/') && url.endsWith('20262027')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ games: [{ gameDate: isoDaysFromNow(9) }] }),
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const result = await resolveNHLSeason(env)
    expect(result).toBe('20262027')
    expect(kvPut).toHaveBeenCalled()
  })

  // Regression (audit 2026-10-06 Worker F3): in Sept 2027, with the seed
  // still 20252026, standings/now says 20272028 with 0 games played. The
  // look-ahead used to run from the seed (-> 20262027, whose first game
  // a year earlier still counted as "imminent"), so 20272028 was never
  // considered until regular-season games had been played.
  describe('Sept 2027, stale seed', () => {
    afterEach(() => { vi.useRealTimers() })
    const schedules = {
      20262027: [{ gameDate: '2026-09-20' }, { gameDate: '2027-04-15' }],
      20272028: [{ gameDate: '2027-09-21' }, { gameDate: '2028-04-14' }],
    }
    const install = () => globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/standings/now')) {
        return Promise.resolve({ ok: true, json: async () => ({ standings: [{ seasonId: 20272028, gamesPlayed: 0 }] }) })
      }
      const season = url.match(/club-schedule-season\/[A-Z]+\/(\d{8})/)?.[1]
      return Promise.resolve({ ok: true, json: async () => ({ games: schedules[season] || [] }) })
    })

    it('resolves 20272028 once its preseason is within the look-ahead', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2027-09-05T12:00:00Z'))
      kvGet.mockResolvedValue(null)
      install()
      expect(await resolveNHLSeason(env)).toBe('20272028')
    })

    it('resolves 20262027 (the candidate\'s prior season, not the seed) before then', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2027-08-01T12:00:00Z'))
      kvGet.mockResolvedValue(null)
      install()
      expect(await resolveNHLSeason(env)).toBe('20262027')
      // 20262027's schedule is never read as "next season".
      expect(globalThis.fetch.mock.calls.map(([u]) => u).some(u => u.endsWith('/20262027'))).toBe(false)
    })
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

  it('rejects a hidden current_season_id and falls back to the most recent REGULAR season — not just the most recent season of any type', async () => {
    // This is the corrected version of a real production bug: the first
    // version of this logic picked the most recent non-hidden season of
    // ANY type, which landed on "9" (2026 Playoffs) here — plausible-
    // looking, but wrong. Almost every pwhl.js endpoint hardcodes
    // season_type=eq.regular on top of whatever season_id it's given, so
    // resolving to a playoffs-type ID made those queries return nothing
    // at all, for every team. Caught via real Cypress failures across
    // standings/players/team/shot-map views, 2026-07-06 — not by this
    // test suite, which is why this fixture exists now.
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
    expect(result.seasonId).toBe(8)
    expect(result.seasonType).toBe('regular')
    expect(result.startYear).toBe(2025)
  })

  // The real 2026-09-28 bootstrap: HockeyTech un-hid 2026-27 (season 11)
  // two months before its first game while current_season_id was the
  // hidden preseason. Picking 11 emptied every PWHL page.
  const SEPT_28_BOOTSTRAP = {
    current_season_id: '10',
    seasons: [
      { id: '11', name: '2026-27 Regular Season', start_date: '2026-12-04', hide_in_standings: false },
      { id: '10', name: '2026-27 Preseason', start_date: '2026-10-01', hide_in_standings: true },
      { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
      { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
    ],
  }

  it('does not jump to a regular season that is still months away (2026-09-28)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-28T17:00:00Z'))
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(SEPT_28_BOOTSTRAP)})` })
    const result = await resolvePWHLSeason(env)
    vi.useRealTimers()
    expect(result.seasonId).toBe(8)
    expect(result.startYear).toBe(2025)
  })

  it('moves to the new regular season once its first game is within two weeks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T17:00:00Z'))
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(SEPT_28_BOOTSTRAP)})` })
    const result = await resolvePWHLSeason(env)
    vi.useRealTimers()
    expect(result.seasonId).toBe(11)
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

  it('resolves the real 2026-07-05 production bootstrap payload to season 8 (regular), not 9 (playoffs) even though 9 is more recent', async () => {
    // Fixture built from an actual captured response (docs/hockeytech-api-notes.md).
    // current_season_id "10" (2026-27 Pre-Season) is hidden. "9" (2026
    // Playoffs, start_date 2026-04-28) is more recent by date than "8"
    // (2025-26 Regular Season, start_date 2025-11-21) — but "8" is the
    // correct answer for this app, because "9" being a playoffs-type
    // season_id breaks every endpoint that filters season_type=eq.regular.
    // This exact fixture is what actually shipped to production and broke
    // Cypress on 2026-07-06 before this fix — it only passes now because
    // resolution prefers season TYPE correctly, not just recency.
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
    expect(result.seasonId).toBe(8)
    expect(result.seasonType).toBe('regular')
    expect(result.startYear).toBe(2025)
  })

  it('falls back to the most recent season of any type only when no regular season exists at all', async () => {
    // Edge case for the new preference logic: if somehow every non-hidden
    // season were a playoffs/preseason/showcase type, don't return
    // nothing — fall back to most-recent-of-any-type rather than the
    // hardcoded FALLBACK_PWHL, since a real (if imperfect) live answer is
    // still better than a static guess.
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '99',
      seasons: [
        { id: '6', name: '2025 Playoffs', start_date: '2025-05-06', hide_in_standings: false },
        { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })
    const result = await resolvePWHLSeason(env)
    expect(result.seasonId).toBe(9)
    expect(result.seasonType).toBe('playoffs')
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

// ── PWHL next season / preseasons ─────────────────────────────
// The full bootstrap seasons[] list as HockeyTech served it on
// 2026-10-01 (id/name/start_date/hide_in_standings, unchanged).
const OCT_1_BOOTSTRAP = {
  current_season_id: '10',
  seasons: [
    { id: '11', name: '2026-27 Regular Season', start_date: '2026-12-04', hide_in_standings: false },
    { id: '10', name: '2026-27 Pre-Season', start_date: '2026-10-01', hide_in_standings: true },
    { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
    { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
    { id: '7', name: '2025-26 Preseason', start_date: '2025-06-01', hide_in_standings: true },
    { id: '6', name: '2025 Playoffs', start_date: '2025-05-06', hide_in_standings: false },
    { id: '5', name: '2024-25 Regular Season', start_date: '2024-11-25', hide_in_standings: false },
    { id: '4', name: '2024-25 Preseason', start_date: '2024-11-01', hide_in_standings: false },
    { id: '3', name: '2024 Playoffs', start_date: '2024-05-06', hide_in_standings: true },
    { id: '1', name: '2024 Regular Season', start_date: '2024-01-01', hide_in_standings: false },
    { id: '2', name: '2024 Preseason', start_date: '2023-11-01', hide_in_standings: false },
  ],
}
// Same shape fetchPWHLBootstrap() caches (and the pure helpers take).
const PARSED_SEASONS = OCT_1_BOOTSTRAP.seasons.map(s => ({
  id: s.id,
  seasonType: deriveSeasonType(s.name),
  startYear: deriveStartYear(s.start_date, s.name),
  hide_in_standings: s.hide_in_standings,
  start_date: s.start_date,
}))
const bootstrapResponse = (payload) => ({ ok: true, text: async () => `(${JSON.stringify(payload)})` })
const byId = (id) => PARSED_SEASONS.find(s => s.id === id)

describe('findPWHLPreseasonFor', () => {
  it('pairs every regular season with the preseason that leads into it', () => {
    expect(findPWHLPreseasonFor(PARSED_SEASONS, byId('11'))?.id).toBe('10')
    expect(findPWHLPreseasonFor(PARSED_SEASONS, byId('8'))?.id).toBe('7')
    expect(findPWHLPreseasonFor(PARSED_SEASONS, byId('5'))?.id).toBe('4')
    expect(findPWHLPreseasonFor(PARSED_SEASONS, byId('1'))?.id).toBe('2')
  })

  it('returns null when no preseason sits between it and the season before', () => {
    const seasons = PARSED_SEASONS.filter(s => s.id !== '10')
    expect(findPWHLPreseasonFor(seasons, byId('11'))).toBeNull()
  })
})

describe('pickPWHLSeasonContext', () => {
  it('names 2026-27 as next, with its preseason, while 2025-26 is current', () => {
    expect(pickPWHLSeasonContext(PARSED_SEASONS, 8)).toEqual({
      next: {
        seasonId: 11, seasonType: 'regular', startYear: 2026, startDate: '2026-12-04',
        preseason: { seasonId: 10, seasonType: 'preseason', startYear: 2026, startDate: '2026-10-01' },
      },
      preseason: { seasonId: 7, seasonType: 'preseason', startYear: 2025, startDate: '2025-06-01' },
    })
  })

  it('has no next season once 2026-27 is current, and its preseason becomes the current one', () => {
    expect(pickPWHLSeasonContext(PARSED_SEASONS, 11)).toEqual({
      next: null,
      preseason: { seasonId: 10, seasonType: 'preseason', startYear: 2026, startDate: '2026-10-01' },
    })
  })

  it('has no next season when HockeyTech lists none after the current one', () => {
    const seasons = PARSED_SEASONS.filter(s => s.id !== '11')
    expect(pickPWHLSeasonContext(seasons, 8).next).toBeNull()
  })

  it('ignores a next regular season that is still hidden', () => {
    const seasons = PARSED_SEASONS.map(s => (s.id === '11' ? { ...s, hide_in_standings: true } : s))
    expect(pickPWHLSeasonContext(seasons, 8).next).toBeNull()
  })

  it('finds the next regular season during the playoffs, with no current preseason', () => {
    expect(pickPWHLSeasonContext(PARSED_SEASONS, 9)).toMatchObject({ next: { seasonId: 11 }, preseason: null })
  })

  it('knows nothing about a current season the bootstrap does not list', () => {
    expect(pickPWHLSeasonContext(PARSED_SEASONS, 99)).toEqual({ next: null, preseason: null })
  })
})

describe('resolvePWHLSeasonContext / getSeasonsConfig', () => {
  afterEach(() => { vi.useRealTimers() })

  it('serves next before the 14-day lookahead lets it become current (2026-10-01)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T17:00:00Z'))
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    const ctx = await resolvePWHLSeasonContext(env)
    expect(ctx.next).toMatchObject({ seasonId: 11, startYear: 2026, startDate: '2026-12-04', preseason: { seasonId: 10 } })
  })

  it('serves no next season after the switch (2026-11-25)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T17:00:00Z'))
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    const ctx = await resolvePWHLSeasonContext(env)
    expect(ctx).toEqual({ next: null, preseason: expect.objectContaining({ seasonId: 10 }) })
  })

  it('agrees with a cached current season rather than recomputing it from the clock', async () => {
    // A current season cached a few hours before the switch still has 11
    // as next, even once the lookahead would pick 11 itself.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-21T01:00:00Z'))
    kvGet.mockImplementation(async (_env, key) => (key === 'config:season:pwhl'
      ? { seasonId: 8, seasonType: 'regular', startYear: 2025 }
      : null))
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    expect((await resolvePWHLSeasonContext(env)).next?.seasonId).toBe(11)
  })

  it('returns nulls, not a guess, when the bootstrap is unavailable', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    expect(await resolvePWHLSeasonContext(env)).toEqual({ next: null, preseason: null })
  })

  it('adds next and preseason to the pwhl entry of /config/seasons', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T17:00:00Z'))
    kvGet.mockImplementation(async (_env, key) => ({
      'config:season:nhl': { seasonId: '20262027' },
      'config:season:ahl': { seasonId: 94, seasonType: 'regular' },
      'config:season:echl': { seasonId: 80, seasonType: 'regular' },
    })[key] ?? null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    const config = await getSeasonsConfig(env)
    expect(config.pwhl).toMatchObject({
      seasonId: 8, seasonType: 'regular', startYear: 2025, startDate: '2025-11-21',
      next: { seasonId: 11, seasonType: 'regular', startYear: 2026, startDate: '2026-12-04', preseason: { seasonId: 10 } },
      preseason: { seasonId: 7 },
    })
    expect(config.nhl).toEqual({ seasonId: '20262027' })
  })
})

describe('getPWHLScheduleSeasonIds', () => {
  it('spans the current season, its preseason, HockeyTech\'s current season and the next season with its preseason', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    expect(await getPWHLScheduleSeasonIds(env, { seasonId: 8 })).toEqual([7, 8, 10, 11])
  })

  it('keeps the 2026-27 preseason after the switch to 2026-27', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    expect(await getPWHLScheduleSeasonIds(env, { seasonId: 11 })).toEqual([10, 11])
  })

  it('falls back to the current season alone when the bootstrap is unavailable', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    expect(await getPWHLScheduleSeasonIds(env, { seasonId: 8 })).toEqual([8])
  })
})

// ── getAllPWHLSeasonTypes ───────────────────────────────────────
// Backs the Python pipeline's get_season_type(season_id) — the fix for
// pipeline modules silently defaulting an unrecognized season_id to
// "regular" instead of looking up its real type (Session 37 follow-up).
describe('getAllPWHLSeasonTypes', () => {
  it('returns an id -> season_type map built from the bootstrap seasons list', async () => {
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '8',
      seasons: [
        { id: '7', name: '2025-26 Preseason', start_date: '2025-06-01', hide_in_standings: true },
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
        { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })

    const result = await getAllPWHLSeasonTypes(env)

    expect(result).toEqual({ '7': 'preseason', '8': 'regular', '9': 'playoffs' })
  })

  it('caches the parsed bootstrap under its own KV key so a later call does not re-fetch', async () => {
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '8',
      seasons: [
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })

    await getAllPWHLSeasonTypes(env)
    expect(kvPut).toHaveBeenCalledWith(
      env, 'config:season:pwhl:bootstrap', expect.any(Object), expect.any(Number)
    )

    // Simulate the KV cache now holding what was just written, then confirm
    // a second call reads from it instead of hitting HockeyTech again.
    const cachedBootstrap = kvPut.mock.calls.find(c => c[1] === 'config:season:pwhl:bootstrap')[2]
    kvGet.mockImplementation((_env, key) =>
      Promise.resolve(key === 'config:season:pwhl:bootstrap' ? cachedBootstrap : null)
    )
    globalThis.fetch.mockClear()

    const result = await getAllPWHLSeasonTypes(env)
    expect(result).toEqual({ '8': 'regular' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('shares the cached bootstrap fetch with resolvePWHLSeason — one network call answers both questions', async () => {
    kvGet.mockResolvedValue(null)
    const bootstrapPayload = {
      current_season_id: '8',
      seasons: [
        { id: '8', name: '2025-26 Regular Season', start_date: '2025-11-21', hide_in_standings: false },
        { id: '9', name: '2026 Playoffs', start_date: '2026-04-28', hide_in_standings: false },
      ],
    }
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => `(${JSON.stringify(bootstrapPayload)})` })

    await resolvePWHLSeason(env)

    const cachedBootstrap = kvPut.mock.calls.find(c => c[1] === 'config:season:pwhl:bootstrap')[2]
    kvGet.mockImplementation((_env, key) =>
      Promise.resolve(key === 'config:season:pwhl:bootstrap' ? cachedBootstrap : null)
    )
    globalThis.fetch.mockClear()

    const types = await getAllPWHLSeasonTypes(env)
    expect(types).toEqual({ '8': 'regular', '9': 'playoffs' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns null (not a thrown error) when the bootstrap fetch fails entirely', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    const result = await getAllPWHLSeasonTypes(env)
    expect(result).toBeNull()
  })

  it('returns null on a non-OK HTTP response, without throwing', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: false, status: 502 })
    const result = await getAllPWHLSeasonTypes(env)
    expect(result).toBeNull()
  })
})

// ── getAllAHLSeasons / getAllECHLSeasons ──────────────────────
// Back /config/seasons/comparison (seasonType/startYear) and the pipeline's
// /config/seasons/{ahl,echl}-seasons (name, type and start/end dates).
describe.each([
  ['getAllAHLSeasons', getAllAHLSeasons, 'config:season:ahl:seasons', 'client_code=ahl'],
  ['getAllECHLSeasons', getAllECHLSeasons, 'config:season:echl:seasons', 'client_code=echl'],
])('%s', (_name, getAll, kvKey, clientParam) => {
  const FEED = [
    { season_id: '90', season_name: '2025-26 Regular Season', career: '1', playoff: '0', start_date: '2025-10-10', end_date: '2026-04-19' },
    { season_id: '92', season_name: '2026 Calder Cup Playoffs', career: '1', playoff: '1', start_date: '2026-04-22', end_date: '2026-06-20' },
    { season_id: '5', season_name: '2026 All-Star Challenge', career: '0', playoff: '0', start_date: '', end_date: null },
  ]

  it('returns every season with its name, type, start year and dates', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ SiteKit: { Seasons: FEED } }) })

    expect(await getAll(env)).toEqual([
      { seasonId: 90, seasonName: '2025-26 Regular Season', seasonType: 'regular', startYear: 2025, startDate: '2025-10-10', endDate: '2026-04-19' },
      { seasonId: 92, seasonName: '2026 Calder Cup Playoffs', seasonType: 'playoffs', startYear: 2026, startDate: '2026-04-22', endDate: '2026-06-20' },
      { seasonId: 5, seasonName: '2026 All-Star Challenge', seasonType: 'allstar', startYear: 2026, startDate: null, endDate: null },
    ])
    expect(String(globalThis.fetch.mock.calls[0][0])).toContain(clientParam)
    expect(kvPut).toHaveBeenCalledWith(env, kvKey, FEED, expect.any(Number))
  })

  it('reads a hyphenated Pre-Season and All-Star name by their letters', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ SiteKit: { Seasons: [
      { season_id: '93', season_name: '2026-27 Pre-Season', career: '1', playoff: '0', start_date: '2026-09-24', end_date: '2026-10-05' },
      { season_id: '6', season_name: '2026 All Star Classic', career: '0', playoff: '0', start_date: '2026-02-01', end_date: '2026-02-02' },
    ] } }) })
    expect((await getAll(env)).map(s2 => s2.seasonType)).toEqual(['preseason', 'allstar'])
  })

  it('reads the cached feed instead of refetching', async () => {
    kvGet.mockImplementation((_env, key) => Promise.resolve(key === kvKey ? FEED : null))
    const result = await getAll(env)
    expect(result).toHaveLength(3)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('returns null (not a thrown error) when the feed fetch fails', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue({ ok: false, status: 503 })
    expect(await getAll(env)).toBeNull()
  })
})

// ── PWHL season labels ────────────────────────────────────────
// Every season in HockeyTech's real list (OCT_1_BOOTSTRAP, unchanged on
// 2026-10-06), labelled the way the app's hand-checked PWHL_SEASONS has
// them. Before 2026-10 the comparison chips read 9 "2026-27 Playoffs",
// 1 "2024-25" (a second one, next to 5), and the hidden 3 "Season 3".
describe('PWHL season labels', () => {
  const EXPECTED = {
    11: { startYear: 2026, label: '2026-27' },
    10: { startYear: 2026, label: '2026-27 Preseason' },
    9: { startYear: 2025, label: '2025-26 Playoffs' },
    8: { startYear: 2025, label: '2025-26' },
    // Listed from 2025-06-01, but it leads into season 8.
    7: { startYear: 2025, label: '2025-26 Preseason' },
    6: { startYear: 2024, label: '2024-25 Playoffs' },
    5: { startYear: 2024, label: '2024-25' },
    4: { startYear: 2024, label: '2024-25 Preseason' },
    3: { startYear: 2023, label: '2023-24 Playoffs' },
    // "2024 Regular Season": the inaugural season, 2024-01-01 to 2024-05-27.
    1: { startYear: 2023, label: '2023-24' },
    // "2024 Preseason" (2023-11-01 to 2023-12-31): a preseason, not a
    // showcase, leading into season 1.
    2: { startYear: 2023, label: '2023-24 Preseason' },
  }

  it('hockeySeasonStartYear: July onwards is that year\'s season, January-June the previous year\'s', () => {
    expect(hockeySeasonStartYear('2025-11-21')).toBe(2025)
    expect(hockeySeasonStartYear('2024-01-01')).toBe(2023)
    expect(hockeySeasonStartYear('2026-04-28')).toBe(2025)
    expect(hockeySeasonStartYear('2026-07-01')).toBe(2026)
    expect(hockeySeasonStartYear('2026-06-30')).toBe(2025)
    expect(hockeySeasonStartYear(null)).toBeNull()
  })

  it('pwhlSeasonLabel formats each type', () => {
    expect(pwhlSeasonLabel(2025, 'regular')).toBe('2025-26')
    expect(pwhlSeasonLabel(2025, 'playoffs')).toBe('2025-26 Playoffs')
    expect(pwhlSeasonLabel(2026, 'preseason')).toBe('2026-27 Preseason')
    expect(pwhlSeasonLabel(2099, 'regular')).toBe('2099-00')
    expect(pwhlSeasonLabel(null, 'regular')).toBeNull()
  })

  it('derives every listed season\'s year from its dates and type', () => {
    const years = pwhlSeasonStartYears(PARSED_SEASONS)
    expect(Object.fromEntries([...years].map(([id, y]) => [id, y]))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([id, e]) => [id, e.startYear])),
    )
  })

  it('getAllPWHLSeasons lists every season, hidden ones included, with its label and start date', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockResolvedValue(bootstrapResponse(OCT_1_BOOTSTRAP))
    const seasons = await getAllPWHLSeasons(env)
    expect(seasons).toHaveLength(11)
    for (const s of seasons) {
      expect({ id: s.seasonId, startYear: s.startYear, label: s.label }).toEqual({ id: s.seasonId, ...EXPECTED[s.seasonId] })
    }
    expect(seasons.find(s => s.seasonId === 3)).toEqual({
      seasonId: 3, seasonType: 'playoffs', startYear: 2023, startDate: '2024-05-06', label: '2023-24 Playoffs',
    })
  })

  it('labels a preseason whose regular season isn\'t listed yet from its own start date', () => {
    const years = pwhlSeasonStartYears([
      { id: '12', seasonType: 'preseason', start_date: '2027-10-01' },
      { id: '11', seasonType: 'regular', start_date: '2026-12-04' },
    ])
    expect(years.get('12')).toBe(2027)
  })

  it('getAllPWHLSeasons returns null, not a guess, when the bootstrap is unavailable', async () => {
    kvGet.mockResolvedValue(null)
    globalThis.fetch.mockRejectedValue(new Error('network down'))
    expect(await getAllPWHLSeasons(env)).toBeNull()
  })
})
