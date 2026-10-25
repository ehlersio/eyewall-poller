// src/__tests__/contracts-summary-roster.test.js
// buildLeagueRosterSummary and GET /contracts/summary?basis=roster: each
// team's roster cap hit from the rosters joined to the dataset, a traded
// player counted for the team he is on, off-roster signings by signing
// team, and the route's KV key / no caching with a roster missing.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildLeagueRosterSummary } from '../contracts.js'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import { handleNHL, TEAM_CONFIGS } from '../nhl.js'

const STAMP = '2026-10-24T12:08:21+00:00'
const base = {
  signed_at: '2024-07-01', contract_type: 'standard', term_years: 3, total_usd: null, one_way: true,
  start_season: '2024-25', end_season: '2027-28', expiry_status: 'UFA', expiry_type: 'UFA', expiry_type_derived: false,
  is_current: true, years_left: 1, n_sources: 1, best_tier: 'B', conflicts: null, flags: null, dataset_updated_at: STAMP,
}
const CONTRACTS = [
  { ...base, contract_key: 'a', player_id: 1, player_name: 'Aho', team: 'CAR', aav_usd: 9_750_000, cap_hit_usd: 9_750_000, end_season: '2031-32' },
  // signed by CAR, on TOR's roster today: counts for TOR
  { ...base, contract_key: 'b', player_id: 2, player_name: 'Traded', team: 'CAR', aav_usd: 2_000_000, cap_hit_usd: 2_000_000, end_season: '2026-27' },
  { ...base, contract_key: 'c', player_id: 3, player_name: 'Matthews', team: 'TOR', aav_usd: 13_250_000, cap_hit_usd: 13_250_000 },
  // CAR signing in the minors: off roster, attributed to CAR
  { ...base, contract_key: 'd', player_id: 4, player_name: 'Nadeau', team: 'CAR', aav_usd: 918_333, cap_hit_usd: 918_333, contract_type: 'ELC', expiry_type: 'RFA', end_season: '2026-27' },
  // on CAR's roster with a row but no figure
  { ...base, contract_key: 'e', player_id: 5, player_name: 'Jarvis', team: 'CAR', aav_usd: null, cap_hit_usd: null, end_season: '2031-32' },
]
const CAP = { season: '2026-27', cap_ceiling: 104_000_000, cap_floor: 77_000_000, min_salary: 850_000, updated_at: STAMP }
const player = (id, last, positionCode = 'C') => ({ id, firstName: { default: 'F' }, lastName: { default: last }, positionCode })
const ROSTERS = {
  CAR: { forwards: [player(1, 'Aho'), player(5, 'Jarvis'), player(6, 'Unsigned')], defensemen: [], goalies: [] },
  TOR: { forwards: [player(3, 'Matthews'), player(2, 'Traded')], defensemen: [], goalies: [] },
  BUF: null,
}
function fakeDb({ contracts = CONTRACTS } = {}) {
  const get = async (path) => {
    if (path.startsWith('nhl_cap_limits?')) return [CAP]
    if (path.startsWith('nhl_contract_seasons?')) return []
    if (path.startsWith('nhl_contracts?')) return contracts
    throw new Error(`unexpected path ${path}`)
  }
  return { get, getAll: get }
}

describe('buildLeagueRosterSummary', () => {
  it('totals each roster by the team the player is on today, roster size and figures counted', async () => {
    const out = await buildLeagueRosterSummary({ ...fakeDb(), season: '2026-27', rosters: ROSTERS })
    expect(out).toMatchObject({ season: '2026-27', basis: 'roster', asOf: STAMP, teamsKnown: 2, unavailable: false, capLimits: { ceiling: 104_000_000 } })
    expect(out.teams.map(t => t.team)).toEqual(['TOR', 'CAR'])
    const [tor, car] = out.teams
    expect(tor).toMatchObject({ rosterCount: 2, rosterWithFigure: 2, rosterCapHit: 15_250_000, offRosterCount: 0, expiring: { ufa: 1, rfa: 0, unknown: 0 } })
    // CAR: Aho (figure), Jarvis (row, no figure), Unsigned (no row); Nadeau off roster, signed by CAR
    expect(car).toMatchObject({ rosterCount: 3, rosterWithFigure: 1, rosterCapHit: 9_750_000, offRosterCount: 1, expiring: { ufa: 0, rfa: 0, unknown: 0 } })
  })

  it('lists a known roster with nothing signed, skips unknown rosters, and is unavailable without contracts', async () => {
    const rosters = { ...ROSTERS, BUF: { forwards: [player(9, 'Nobody')], defensemen: [], goalies: [] } }
    const out = await buildLeagueRosterSummary({ ...fakeDb(), season: '2026-27', rosters })
    expect(out.teamsKnown).toBe(3)
    expect(out.teams.at(-1)).toMatchObject({ team: 'BUF', rosterCount: 1, rosterWithFigure: 0, rosterCapHit: 0 })
    const none = await buildLeagueRosterSummary({ ...fakeDb({ contracts: [] }), season: '2026-27', rosters: ROSTERS })
    expect(none.unavailable).toBe(true)
    expect(none.teams.map(t => t.rosterCapHit)).toEqual([0, 0])
  })
})

describe('GET /contracts/summary?basis=roster (route)', () => {
  const respond = rows => ({ ok: true, json: async () => rows })
  const isNhlApi = u => new URL(String(u)).hostname === 'api-web.nhle.com'
  const db = (u) => {
    if (u.includes('nhl_cap_limits')) return respond([CAP])
    if (u.includes('nhl_contract_seasons')) return respond([])
    if (u.includes('nhl_contracts?')) return respond(CONTRACTS)
    return respond([])
  }
  const call = (path, env) => handleNHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
  const allRosters = () => Object.fromEntries(Object.keys(TEAM_CONFIGS).map(abbr => [`roster:${abbr}`, ROSTERS[abbr] || { forwards: [], defensemen: [], goalies: [] }]))
  afterEach(() => { vi.restoreAllMocks() })

  it('serves the roster basis under its own KV key, 1hr, without touching the signing-team key', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...allRosters() }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/rest/v1/')) return db(u)
      throw new Error(`unexpected fetch ${u}`)
    })
    const res = await call('/contracts/summary?basis=roster', env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ basis: 'roster', season: '2026-27', teamsKnown: Object.keys(TEAM_CONFIGS).length, unavailable: false })
    expect(body.teams[0]).toMatchObject({ team: 'TOR', rosterCapHit: 15_250_000 })
    expect(body.teams).toHaveLength(Object.keys(TEAM_CONFIGS).length)
    expect(globalThis.fetch.mock.calls.some(([u]) => isNhlApi(u))).toBe(false)
    expect(JSON.parse(await env.CACHE.get('nhl:contracts:summary:roster:2026-27'))).toEqual(body)
    expect(await env.CACHE.get('nhl:contracts:summary:2026-27')).toBeNull()
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600')
  })

  it('keeps the signing-team basis as the default', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...allRosters() }) })
    globalThis.fetch = vi.fn(async (url) => db(String(url)))
    const body = await (await call('/contracts/summary', env)).json()
    expect(body.basis).toBe('signing_team')
    expect(body.teams.find(t => t.team === 'CAR').capHitTotal).toBe(9_750_000 + 2_000_000 + 918_333)
  })

  it('does not cache while a roster is missing, and never caches a failed read', async () => {
    const rosters = allRosters()
    delete rosters['roster:BUF']
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...rosters }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (isNhlApi(u)) return { ok: false, status: 503, json: async () => ({}) }
      return db(u)
    })
    const res = await call('/contracts/summary?basis=roster', env)
    const body = await res.json()
    expect(body.teamsKnown).toBe(Object.keys(TEAM_CONFIGS).length - 1)
    expect(await env.CACHE.get('nhl:contracts:summary:roster:2026-27')).toBeNull()
    expect(res.headers.get('Cache-Control')).toContain('max-age=0')

    const env2 = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...allRosters() }) })
    globalThis.fetch = vi.fn(async () => { throw new Error('db down') })
    const failed = await (await call('/contracts/summary?basis=roster', env2)).json()
    expect(failed).toMatchObject({ basis: 'roster', teams: [], unavailable: true, teamsKnown: Object.keys(TEAM_CONFIGS).length })
    expect(await env2.CACHE.get('nhl:contracts:summary:roster:2026-27')).toBeNull()
  })
})
