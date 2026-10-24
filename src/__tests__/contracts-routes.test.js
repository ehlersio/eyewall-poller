// src/__tests__/contracts-routes.test.js
// Route tests for GET /contracts, /contracts/player/:id, /contracts/summary
// and /config/cap (nhl.js). The builders are unit-tested in
// contracts.test.js; these cover the route layer: the season default and
// its validation, the roster coming from KV (or fetched and cached),
// the KV keys and TTLs, and that empty / failed answers are not cached.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import { handleNHL } from '../nhl.js'

const STAMP = '2026-10-24T12:08:21+00:00'
const ROSTER = {
  forwards: [{ id: 8478427, firstName: { default: 'Sebastian' }, lastName: { default: 'Aho' }, positionCode: 'C' }],
  defensemen: [], goalies: [],
}
const AHO = {
  contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, player_name: 'Sebastian Aho', team: 'CAR', signed_at: '2023-07-01',
  contract_type: 'extension', term_years: 8, aav_usd: 9_750_000, cap_hit_usd: 9_750_000, total_usd: 78_000_000, one_way: true,
  start_season: '2024-25', end_season: '2031-32', expiry_status: 'UFA', expiry_type: 'UFA', expiry_type_derived: false,
  is_current: true, years_left: 5, n_sources: 2, best_tier: 'C', conflicts: null, flags: null, dataset_updated_at: STAMP,
}
const CAP = { season: '2026-27', cap_ceiling: 104_000_000, cap_floor: 77_000_000, min_salary: 850_000, updated_at: STAMP }

const respond = rows => ({ ok: true, json: async () => rows })
const supabase = (handler) => vi.fn(async (url) => {
  const u = String(url)
  if (u.includes('/rest/v1/')) return handler(u)
  throw new Error(`unexpected fetch ${u}`)
})
const defaultDb = (u) => {
  if (u.includes('nhl_cap_limits')) return respond([CAP])
  if (u.includes('nhl_contracts?')) return respond([AHO])
  return respond([])
}
const call = (path, env) => handleNHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
// Season override so no standings/now fetch happens; roster warm in KV.
const envWith = (extra = {}) => makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, 'roster:CAR': ROSTER, ...extra }) })

afterEach(() => { vi.restoreAllMocks() })

describe('GET /contracts', () => {
  it('serves the team for the live season, from the KV roster, and caches 1hr', async () => {
    const env = envWith()
    globalThis.fetch = supabase(defaultDb)
    const res = await call('/contracts?team=CAR', env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ team: 'CAR', season: '2026-27', asOf: STAMP, rosterKnown: true, unavailable: false })
    expect(body.rows[0]).toMatchObject({ playerId: 8478427, capHit: 9_750_000, position: 'C', onRoster: true, yearsLeft: 5 })
    expect(body.summary).toMatchObject({ rosterCapHit: 9_750_000, capLimits: { ceiling: 104_000_000 } })
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).includes('api-web.nhle.com'))).toBe(false)
    expect(globalThis.fetch.mock.calls[0][0]).toContain('player_id.in.(8478427)')
    expect(JSON.parse(await env.CACHE.get('nhl:contracts:CAR:2026-27'))).toEqual(body)
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600')
  })

  it('fetches and caches the roster when it is not in KV', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027 }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('api-web.nhle.com/v1/roster/CAR/current')) return respond(ROSTER)
      return defaultDb(u)
    })
    const body = await (await call('/contracts?team=CAR', env)).json()
    expect(body.rosterKnown).toBe(true)
    expect(JSON.parse(await env.CACHE.get('roster:CAR'))).toEqual(ROSTER)
  })

  it('a roster fetch failure degrades to team-signed rows only, and is not cached', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027 }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('api-web.nhle.com')) return { ok: false, status: 503, text: async () => 'down' }
      return defaultDb(u)
    })
    const res = await call('/contracts?team=CAR', env)
    const body = await res.json()
    expect(body).toMatchObject({ rosterKnown: false, unavailable: false })
    expect(body.rows[0].onRoster).toBe(false)
    expect(await env.CACHE.get('nhl:contracts:CAR:2026-27')).toBeNull()
    expect(res.headers.get('Cache-Control')).toContain('max-age=0')
  })

  it('honours ?season= and keys the cache by it; rejects a malformed one before any read', async () => {
    const env = envWith()
    globalThis.fetch = supabase(defaultDb)
    const ok = await call('/contracts?team=CAR&season=2027-28', env)
    expect((await ok.json()).season).toBe('2027-28')
    expect(globalThis.fetch.mock.calls[0][0]).toContain('start_season=lte.2027-28&end_season=gte.2027-28')
    expect(await env.CACHE.get('nhl:contracts:CAR:2027-28')).not.toBeNull()

    globalThis.fetch = vi.fn()
    const bad = await call('/contracts?team=CAR&season=2027-28)&select=*', env)
    expect(bad.status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('a team with no rows answers unavailable and is not cached', async () => {
    const env = envWith()
    globalThis.fetch = supabase(u => (u.includes('nhl_cap_limits') ? respond([CAP]) : respond([])))
    const res = await call('/contracts?team=CAR', env)
    const body = await res.json()
    expect(body).toMatchObject({ unavailable: true, rows: [] })
    expect(body.missing).toEqual([{ playerId: 8478427, name: 'Sebastian Aho', position: 'C', gap: 'no_contract', status: null }])
    expect(await env.CACHE.get('nhl:contracts:CAR:2026-27')).toBeNull()
  })

  it('a Supabase failure (table not migrated yet) answers unavailable and is not cached', async () => {
    const env = envWith()
    globalThis.fetch = supabase(() => ({ ok: false, status: 404 }))
    const res = await call('/contracts?team=CAR', env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ team: 'CAR', season: '2026-27', asOf: null, rosterKnown: true, rows: [], missing: [], summary: null, unavailable: true })
    expect(await env.CACHE.get('nhl:contracts:CAR:2026-27')).toBeNull()
  })

  it('warm cache: no reads at all', async () => {
    const cached = { team: 'CAR', season: '2026-27', rows: [], unavailable: false }
    const env = envWith({ 'nhl:contracts:CAR:2026-27': cached })
    globalThis.fetch = vi.fn()
    expect(await (await call('/contracts?team=CAR', env)).json()).toEqual(cached)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('GET /contracts/player/:id', () => {
  it('serves the history and current contract, keyed by player and season', async () => {
    const env = envWith()
    globalThis.fetch = supabase(defaultDb)
    const res = await call('/contracts/player/8478427', env)
    const body = await res.json()
    expect(body).toMatchObject({ playerId: 8478427, season: '2026-27', unavailable: false })
    expect(body.current.contractKey).toBe('sebastian aho|CAR|2023-07')
    expect(body.history).toHaveLength(1)
    expect(globalThis.fetch.mock.calls.every(([u]) => String(u).includes('player_id=eq.8478427'))).toBe(true)
    expect(await env.CACHE.get('nhl:contracts:player:8478427:2026-27')).not.toBeNull()
  })

  it('rejects a non-numeric id before any read', async () => {
    const env = envWith()
    globalThis.fetch = vi.fn()
    expect((await call('/contracts/player/8478427)&x=1', env)).status).toBe(400)
    expect((await call('/contracts/player/', env)).status).toBe(400)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('unknown player: unavailable, not cached', async () => {
    const env = envWith()
    globalThis.fetch = supabase(() => respond([]))
    const body = await (await call('/contracts/player/1', env)).json()
    expect(body).toMatchObject({ playerId: 1, current: null, history: [], unavailable: true })
    expect(await env.CACHE.get('nhl:contracts:player:1:2026-27')).toBeNull()
  })
})

describe('GET /contracts/summary', () => {
  it('serves every signing team for the season and caches 1hr', async () => {
    const env = envWith()
    globalThis.fetch = supabase(defaultDb)
    const body = await (await call('/contracts/summary', env)).json()
    expect(body).toMatchObject({ season: '2026-27', basis: 'signing_team', asOf: STAMP, unavailable: false })
    expect(body.teams).toEqual([{ team: 'CAR', contracts: 1, withFigure: 1, capHitTotal: 9_750_000, expiring: { ufa: 0, rfa: 0, unknown: 0 } }])
    expect(await env.CACHE.get('nhl:contracts:summary:2026-27')).not.toBeNull()
  })

  it('failed read: unavailable, not cached', async () => {
    const env = envWith()
    globalThis.fetch = supabase(() => ({ ok: false, status: 500 }))
    const res = await call('/contracts/summary', env)
    expect(await res.json()).toMatchObject({ teams: [], unavailable: true })
    expect(await env.CACHE.get('nhl:contracts:summary:2026-27')).toBeNull()
  })
})

describe('GET /config/cap', () => {
  it('serves the announced seasons with the live season label, cached 24hr', async () => {
    const env = envWith()
    globalThis.fetch = supabase(defaultDb)
    const res = await call('/config/cap', env)
    expect(await res.json()).toEqual({
      current: '2026-27',
      seasons: { '2026-27': { ceiling: 104_000_000, floor: 77_000_000, minSalary: 850_000 } },
    })
    // withHttpCache() caps the header at 1hr; the KV entry carries the 24hr TTL
    expect(res.headers.get('Cache-Control')).toContain('max-age=')
    expect(await env.CACHE.get('nhl:config:cap')).not.toBeNull()
  })

  it('no rows or a failed read: unavailable, not cached', async () => {
    const env = envWith()
    globalThis.fetch = supabase(() => respond([]))
    expect(await (await call('/config/cap', env)).json()).toEqual({ current: '2026-27', seasons: {}, unavailable: true })
    globalThis.fetch = supabase(() => ({ ok: false, status: 500 }))
    expect(await (await call('/config/cap', env)).json()).toEqual({ current: '2026-27', seasons: {}, unavailable: true })
    expect(await env.CACHE.get('nhl:config:cap')).toBeNull()
  })
})
