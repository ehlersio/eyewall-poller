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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../seasons.js', () => ({
  getSeasonsConfig: vi.fn(),
  refreshSeasonsCache: vi.fn(),
  getAllPWHLSeasonTypes: vi.fn(),
  getAllPWHLSeasons: vi.fn(),
  resolveNHLSeason: vi.fn().mockResolvedValue(20252026),
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
}))
vi.mock('../nhl.js', async () => {
  const actual = await vi.importActual('../nhl.js')
  return {
    handleNHL: vi.fn().mockResolvedValue(new Response('nhl-handler-called')),
    poll: vi.fn(),
    refreshPPUnits: vi.fn(),
    TEAM_CONFIGS: actual.TEAM_CONFIGS,
  }
})
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
import { getSeasonsConfig, getAllPWHLSeasonTypes, getAllPWHLSeasons } from '../seasons.js'
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

describe('GET /config/seasons/comparison', () => {
  function mockSupabaseFetch({ nhlRows, pwhlRows }) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/rest/v1/team_seasons?')) {
        return Promise.resolve({ ok: true, json: async () => nhlRows })
      }
      if (u.includes('/rest/v1/pwhl_team_seasons?')) {
        return Promise.resolve({ ok: true, json: async () => pwhlRows })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
  }

  it('serves from KV cache without hitting Supabase', async () => {
    const cachedResult = { nhl: { activeTeamCount: 32, seasons: [] }, pwhl: { activeTeamCount: 12, seasons: [] } }
    const env = makeEnv({ CACHE: { async get() { return JSON.stringify(cachedResult) }, async put() {} } })

    const res = await worker.fetch(makeRequest('/config/seasons/comparison'), env, makeCtx())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(cachedResult)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('flags a season above the strict->half-active-teams threshold as comparable and one at/below it as not', async () => {
    // NHL: 32 active teams (real TEAM_CONFIGS) -> threshold is >16.
    // 20262027: 20 distinct teams -> comparable. 20232024: exactly 16 -> NOT comparable (strict >, not >=).
    // season comes back from Supabase as a number (bigint column), not a string -- use real numeric
    // values here (a prior version of this test used strings and missed a live `.localeCompare` crash).
    const nhlRows = [
      ...Array.from({ length: 20 }, (_, i) => ({ season: 20262027, team: `T${i}` })),
      ...Array.from({ length: 16 }, (_, i) => ({ season: 20232024, team: `T${i}` })),
    ]
    // PWHL: 12 active teams (real PWHL_TEAM_CODES) -> threshold is >6.
    // season 8: 8 distinct teams -> comparable. season 9: 4 distinct teams -> NOT comparable.
    const pwhlRows = [
      ...Array.from({ length: 8 }, (_, i) => ({ season_id: 8, team_id: i })),
      ...Array.from({ length: 4 }, (_, i) => ({ season_id: 9, team_id: i })),
    ]
    mockSupabaseFetch({ nhlRows, pwhlRows })
    getAllPWHLSeasons.mockResolvedValue([
      { seasonId: 8, seasonType: 'regular', startYear: 2025 },
      { seasonId: 9, seasonType: 'playoffs', startYear: 2025 },
    ])

    const env = makeEnv()
    const res = await worker.fetch(makeRequest('/config/seasons/comparison'), env, makeCtx())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nhl.activeTeamCount).toBe(32)
    expect(body.nhl.seasons).toEqual([
      { season: 20262027, teamCount: 20, comparable: true },
      { season: 20232024, teamCount: 16, comparable: false },
    ])
    expect(body.pwhl.activeTeamCount).toBe(12)
    expect(body.pwhl.seasons).toEqual([
      { seasonId: 9, seasonType: 'playoffs', startYear: 2025, teamCount: 4, comparable: false },
      { seasonId: 8, seasonType: 'regular',  startYear: 2025, teamCount: 8, comparable: true },
    ])

    const cached = await env.CACHE.get('config:seasons:comparison')
    expect(JSON.parse(cached)).toEqual(body)
  })

  it('degrades to an empty season list for a league whose Supabase query fails, without failing the other league', async () => {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/rest/v1/team_seasons?')) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      if (u.includes('/rest/v1/pwhl_team_seasons?')) {
        return Promise.resolve({ ok: true, json: async () => [{ season_id: 8, team_id: 1 }] })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    getAllPWHLSeasons.mockResolvedValue([{ seasonId: 8, seasonType: 'regular', startYear: 2025 }])

    const res = await worker.fetch(makeRequest('/config/seasons/comparison'), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.nhl.seasons).toEqual([])
    expect(body.pwhl.seasons).toHaveLength(1)
  })
})

describe('GET /trivia/today', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mockSupabaseFetch(handler) {
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      if (u.includes('/rest/v1/trivia_questions')) return handler(u)
      throw new Error(`unexpected fetch: ${u}`)
    })
  }

  it('queries easy/medium with an exact question_date match and hard with a lte/order-desc fallback', async () => {
    const seen = []
    mockSupabaseFetch((u) => {
      seen.push(u)
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    await worker.fetch(makeRequest('/trivia/today?sport=nhl&team=CAR'), makeEnv(), makeCtx())

    const easyCall = seen.find((u) => u.includes('tier=eq.easy'))
    const mediumCall = seen.find((u) => u.includes('tier=eq.medium'))
    const hardCall = seen.find((u) => u.includes('tier=eq.hard'))

    expect(easyCall).toContain('question_date=eq.2026-08-12')
    expect(mediumCall).toContain('question_date=eq.2026-08-12')
    expect(hardCall).toContain('question_date=lte.2026-08-12')
    expect(hardCall).toContain('order=question_date.desc')
  })

  it('falls back to the most recent past hard-tier row when none matches today exactly', async () => {
    const staleHard = {
      id: 28, question_date: '2026-08-05', tier: 'hard', sport: 'nhl', team: 'ALL',
      question_text: 'True or False: The NHL was founded in 1917.', options: ['True', 'False'],
      correct_index: 0, explanation: 'Founded 1917.', source: 'curated',
    }
    mockSupabaseFetch((u) => {
      if (u.includes('tier=eq.hard')) return Promise.resolve({ ok: true, json: async () => [staleHard] })
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    const res = await worker.fetch(makeRequest('/trivia/today?sport=nhl&team=CAR'), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.easy).toBeNull()
    expect(body.hard).toEqual(staleHard)
  })
})

describe('GET /milestones/latest', () => {
  // Regression: this badge-only route must stay season-scoped in lockstep
  // with /milestones itself (nhl.js) -- otherwise it can flag "unseen
  // milestone!" for an id that no longer appears anywhere in the
  // now-season-scoped list.
  it('scopes the Supabase query to the live-resolved current season, per sport', async () => {
    const seen = []
    globalThis.fetch = vi.fn((url) => {
      const u = String(url)
      seen.push(u)
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    await worker.fetch(makeRequest('/milestones/latest?sport=nhl'), makeEnv(), makeCtx())
    await worker.fetch(makeRequest('/milestones/latest?sport=pwhl'), makeEnv(), makeCtx())

    const nhlCall  = seen.find((u) => u.includes('is_pwhl=eq.false'))
    const pwhlCall = seen.find((u) => u.includes('is_pwhl=eq.true'))
    expect(nhlCall).toContain('season=eq.20252026')
    expect(pwhlCall).toContain('season=eq.8')
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

  // Session 66: the live season (mocked here as 20252026, per the module
  // mock above) can be flipped ahead of any real player_seasons rows
  // existing for it (schedule released, season hasn't started) -- these
  // cover the one-season-back fallback that kicks in when that season's
  // player_seasons query comes back completely empty.
  describe('current-season player_seasons is empty (season flipped ahead of real data)', () => {
    function mockSupabaseFetchWithPriorSeason({ players, priorTeamRows, pwhlRows }) {
      globalThis.fetch = vi.fn((url) => {
        const u = String(url)
        if (u.includes('/rest/v1/players?')) {
          return Promise.resolve({ ok: true, json: async () => players })
        }
        if (u.includes('season=eq.20252026')) {
          return Promise.resolve({ ok: true, json: async () => [] }) // live season: no rows yet
        }
        if (u.includes('season=eq.20242025')) {
          return Promise.resolve({ ok: true, json: async () => priorTeamRows }) // one season back
        }
        if (u.includes('/rest/v1/pwhl_players?')) {
          return Promise.resolve({ ok: true, json: async () => pwhlRows })
        }
        throw new Error(`unexpected fetch: ${u}`)
      })
    }

    it('falls back to the specific correct team from one season back, flagged as stale', async () => {
      mockSupabaseFetchWithPriorSeason({
        players: [{ id: 8478402, name: 'Connor McDavid', position: 'C' }],
        priorTeamRows: [{ player_id: 8478402, team: 'EDM', updated_at: '2026-04-01T00:00:00Z' }],
        pwhlRows: [],
      })

      const res = await worker.fetch(makeRequest('/players-search-index'), makeEnv(), makeCtx())

      expect(res.status).toBe(200)
      const body = await res.json()
      // Asserts the exact resolved team, not just that it's non-null --
      // "found *a* team" would pass even if the fallback picked up the
      // wrong player's row or the wrong season entirely.
      expect(body).toEqual([
        { id: 8478402, name: 'Connor McDavid', team: 'EDM', teamStale: true, teamSeason: '20242025', position: 'C', sport: 'nhl' },
      ])
    })

    it('degrades to an explicit null team (not stale) for a player with no prior-season row either', async () => {
      mockSupabaseFetchWithPriorSeason({
        players: [{ id: 9999999, name: 'Brand New Rookie', position: 'C' }],
        priorTeamRows: [], // rookie/expansion-style player: no row last season either
        pwhlRows: [],
      })

      const res = await worker.fetch(makeRequest('/players-search-index'), makeEnv(), makeCtx())

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([
        { id: 9999999, name: 'Brand New Rookie', team: null, position: 'C', sport: 'nhl' },
      ])
      expect(body[0]).not.toHaveProperty('teamStale')
    })
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
