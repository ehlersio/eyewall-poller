// src/__tests__/contracts-players.test.js
// buildLeaguePlayers (GET /contracts/players): every player's contract for
// a season in one payload, the rosters joined for currentTeam / position /
// onRoster, roster players without a row kept with nulls, the order, and
// the route layer (KV key, rosters from KV or fetched, not cached while a
// roster is missing).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildLeaguePlayers } from '../contracts.js'
import { makeEnv, makeCtx, makeRequest, makeFakeCache } from './route-harness.js'
import { handleNHL, TEAM_CONFIGS } from '../nhl.js'

const STAMP = '2026-10-24T12:08:21+00:00'
const base = {
  signed_at: '2024-07-01', contract_type: 'standard', term_years: 3, total_usd: null, one_way: true,
  start_season: '2024-25', end_season: '2027-28', expiry_status: 'UFA', expiry_type: 'UFA', expiry_type_derived: false,
  is_current: true, years_left: 1, n_sources: 1, best_tier: 'B', conflicts: null, flags: null, dataset_updated_at: STAMP,
}
const AHO = { ...base, contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, player_name: 'Sebastian Aho', team: 'CAR', aav_usd: 9_750_000, cap_hit_usd: 9_750_000, best_tier: 'C', end_season: '2031-32' }
// Traded to TOR mid-contract: signed by CAR, on Toronto's roster today.
const TRADED = { ...base, contract_key: '8481234|CAR|2024-07', player_id: 8481234, player_name: 'Traded Forward', team: 'CAR', aav_usd: 2_000_000, cap_hit_usd: 2_000_000 }
// Two rows for one Toronto deal; the better tier wins, the other is an alternate.
const TOR_B = { ...base, contract_key: '8479318|TOR|2023-08', player_id: 8479318, player_name: 'Auston Matthews', team: 'TOR', aav_usd: 13_250_000, cap_hit_usd: null, best_tier: 'B' }
const TOR_E = { ...base, contract_key: 'auston matthews|TOR|2023-08', player_id: 8479318, player_name: 'Auston Matthews', team: 'TOR', aav_usd: 13_250_000, cap_hit_usd: 13_250_000, best_tier: 'E' }
// Signed, not on any roster (minors).
const MINORS = { ...base, contract_key: '8484203|CAR|2023-07', player_id: 8484203, player_name: 'Bradly Nadeau', team: 'CAR', aav_usd: 918_333, cap_hit_usd: 918_333, contract_type: 'ELC' }
// A deal that does not cover the season: ignored.
const OLD = { ...base, contract_key: 'old|CAR|2019-07', player_id: 8470000, player_name: 'Old Deal', team: 'CAR', aav_usd: 1, cap_hit_usd: 1, start_season: '2019-20', end_season: '2023-24' }
const CONTRACTS = [AHO, TRADED, TOR_B, TOR_E, MINORS, OLD]
const SEASONS = [
  { contract_key: 'auston matthews|TOR|2023-08', player_id: 8479318, team: 'TOR', season: '2026-27', cap_hit_usd: 13_250_000, aav_usd: 13_250_000, best_tier: 'E' },
  { contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, team: 'CAR', season: '2026-27', cap_hit_usd: 9_750_000, aav_usd: 9_750_000, best_tier: 'E' },
  { contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, team: 'CAR', season: '2027-28', cap_hit_usd: 9_750_000, aav_usd: 9_750_000, best_tier: 'E' },
]
const CAP = { season: '2026-27', cap_ceiling: 104_000_000, cap_floor: 77_000_000, min_salary: 850_000, updated_at: STAMP }

const player = (id, first, last, positionCode) => ({ id, firstName: { default: first }, lastName: { default: last }, positionCode })
const ROSTERS = {
  CAR: { forwards: [player(8478427, 'Sebastian', 'Aho', 'C'), player(8482100, 'Alexander', 'Nikishin', 'D')], defensemen: [], goalies: [] },
  TOR: { forwards: [player(8479318, 'Auston', 'Matthews', 'C'), player(8481234, 'Traded', 'Forward', 'L')], defensemen: [], goalies: [] },
  BUF: null,
}

function fakeDb({ contracts = CONTRACTS, seasons = SEASONS, caps = [CAP] } = {}) {
  const calls = []
  const get = async (path) => {
    calls.push(path)
    if (path.startsWith('nhl_cap_limits?')) return caps
    if (path.startsWith('nhl_contract_seasons?')) {
      const season = path.match(/season=eq\.([\d-]+)/)?.[1]
      return seasons.filter(r => r.season === season)
    }
    if (path.startsWith('nhl_contracts?')) {
      const season = path.match(/start_season=lte\.([\d-]+)/)?.[1]
      return contracts.filter(r => r.start_season <= season && season <= r.end_season)
    }
    throw new Error(`unexpected path ${path}`)
  }
  return { get, getAll: get, calls }
}

describe('buildLeaguePlayers', () => {
  it('joins every roster to the season\'s contracts, one row per player, cap hit descending', async () => {
    const db = fakeDb()
    const out = await buildLeaguePlayers({ ...db, season: '2026-27', rosters: ROSTERS })
    expect(out).toMatchObject({ season: '2026-27', basis: 'roster', asOf: STAMP, teamsKnown: 2, unavailable: false, capLimits: { ceiling: 104_000_000 } })
    expect(out.players.map(p => p.playerId)).toEqual([8479318, 8478427, 8481234, 8484203, 8482100])
    // three reads: contracts covering the season, that season's rows, cap limits
    expect(db.calls.filter(c => c.startsWith('nhl_contracts?'))[0]).toContain('start_season=lte.2026-27&end_season=gte.2026-27')
    expect(db.calls.some(c => c.startsWith('nhl_contract_seasons?') && c.includes('season=eq.2026-27'))).toBe(true)
    expect(db.calls.some(c => c.startsWith('nhl_contract_clauses?'))).toBe(false)
  })

  it('reads currentTeam / position / onRoster from the roster and keeps the signing team', async () => {
    const out = await buildLeaguePlayers({ ...fakeDb(), season: '2026-27', rosters: ROSTERS })
    const byId = Object.fromEntries(out.players.map(p => [p.playerId, p]))
    expect(byId[8481234]).toMatchObject({ team: 'CAR', currentTeam: 'TOR', position: 'L', onRoster: true, capHit: 2_000_000, capHitSource: 'contract' })
    expect(byId[8478427]).toMatchObject({ team: 'CAR', currentTeam: 'CAR', position: 'C', onRoster: true, capHit: 9_750_000, capHitSource: 'season', yearsLeft: 5, official: true })
    expect(byId[8484203]).toMatchObject({ team: 'CAR', currentTeam: null, position: null, onRoster: false, contractType: 'ELC' })
    expect(byId[8478427].clauses).toBeUndefined()
  })

  it('picks one contract per player and counts the alternates', async () => {
    const out = await buildLeaguePlayers({ ...fakeDb(), season: '2026-27', rosters: ROSTERS })
    const matthews = out.players.find(p => p.playerId === 8479318)
    expect(matthews.contractKey).toBe('8479318|TOR|2023-08')
    expect(matthews.tier).toBe('B')
    expect(matthews.capHit).toBe(13_250_000) // from the season row, though the B row has no cap hit
    expect(matthews.capHitTier).toBe('E')
    expect(matthews.alternates).toBe(1)
    expect(out.players.filter(p => p.playerId === 8479318)).toHaveLength(1)
  })

  it('keeps roster players with no contract row, with nulls, after everyone with a figure', async () => {
    const out = await buildLeaguePlayers({ ...fakeDb(), season: '2026-27', rosters: ROSTERS })
    const nikishin = out.players.at(-1)
    expect(nikishin).toMatchObject({ playerId: 8482100, name: 'Alexander Nikishin', contractKey: null, capHit: null, team: null, currentTeam: 'CAR', position: 'D', onRoster: true, official: false })
  })

  it('ignores deals outside the season and rosters that could not be fetched', async () => {
    const out = await buildLeaguePlayers({ ...fakeDb(), season: '2026-27', rosters: ROSTERS })
    expect(out.players.some(p => p.playerId === 8470000)).toBe(false)
    expect(out.teamsKnown).toBe(2) // BUF null
    const none = await buildLeaguePlayers({ ...fakeDb(), season: '2026-27', rosters: {} })
    expect(none.teamsKnown).toBe(0)
    expect(none.players.every(p => !p.onRoster && p.currentTeam === null)).toBe(true)
  })

  it('is unavailable with no contracts, still listing the roster players', async () => {
    const out = await buildLeaguePlayers({ ...fakeDb({ contracts: [], seasons: [] }), season: '2026-27', rosters: ROSTERS })
    expect(out.unavailable).toBe(true)
    expect(out.asOf).toBeNull()
    expect(out.players).toHaveLength(4)
    expect(out.players.every(p => p.capHit == null)).toBe(true)
  })
})

describe('GET /contracts/players (route)', () => {
  const respond = rows => ({ ok: true, json: async () => rows })
  const isNhlApi = u => new URL(String(u)).hostname === 'api-web.nhle.com'
  const db = (u) => {
    if (u.includes('nhl_cap_limits')) return respond([CAP])
    if (u.includes('nhl_contract_seasons')) return respond(SEASONS)
    if (u.includes('nhl_contracts?')) return respond(CONTRACTS)
    return respond([])
  }
  const call = (path, env) => handleNHL(makeRequest(path), env, makeCtx(), new URL(`https://example.com${path}`))
  const allRosters = () => Object.fromEntries(Object.keys(TEAM_CONFIGS).map(abbr => [`roster:${abbr}`, ROSTERS[abbr] || { forwards: [], defensemen: [], goalies: [] }]))

  afterEach(() => { vi.restoreAllMocks() })

  it('serves every player for the live season from the KV rosters and caches 1hr', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...allRosters() }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/rest/v1/')) return db(u)
      throw new Error(`unexpected fetch ${u}`)
    })
    const res = await call('/contracts/players', env)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ season: '2026-27', basis: 'roster', teamsKnown: Object.keys(TEAM_CONFIGS).length, unavailable: false })
    expect(body.players[0]).toMatchObject({ playerId: 8479318, currentTeam: 'TOR', capHit: 13_250_000 })
    expect(globalThis.fetch.mock.calls.some(([u]) => isNhlApi(u))).toBe(false)
    expect(JSON.parse(await env.CACHE.get('nhl:contracts:players:2026-27'))).toEqual(body)
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600')
  })

  it('fetches a cold roster, caches it, and does not cache the payload while one is missing', async () => {
    const rosters = allRosters()
    delete rosters['roster:CAR']
    delete rosters['roster:BUF']
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...rosters }) })
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (isNhlApi(u) && new URL(u).pathname === '/v1/roster/CAR/current') return respond(ROSTERS.CAR)
      if (isNhlApi(u)) return { ok: false, status: 503, json: async () => ({}) }
      return db(u)
    })
    const res = await call('/contracts/players', env)
    const body = await res.json()
    expect(JSON.parse(await env.CACHE.get('roster:CAR'))).toEqual(ROSTERS.CAR)
    expect(body.teamsKnown).toBe(Object.keys(TEAM_CONFIGS).length - 1)
    expect(body.players.find(p => p.playerId === 8478427)).toMatchObject({ currentTeam: 'CAR', onRoster: true })
    expect(await env.CACHE.get('nhl:contracts:players:2026-27')).toBeNull()
    expect(res.headers.get('Cache-Control')).toContain('max-age=0')
  })

  it('rejects a malformed season and never caches a failed read', async () => {
    const env = makeEnv({ CACHE: makeFakeCache({ 'config:season:nhl:override': 20262027, ...allRosters() }) })
    globalThis.fetch = vi.fn(async () => { throw new Error('db down') })
    expect((await call('/contracts/players?season=2026', env)).status).toBe(400)
    const res = await call('/contracts/players?season=2026-27', env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ season: '2026-27', players: [], teamsKnown: Object.keys(TEAM_CONFIGS).length, unavailable: true })
    expect(await env.CACHE.get('nhl:contracts:players:2026-27')).toBeNull()
  })
})
