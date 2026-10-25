// src/__tests__/contracts.test.js
// Unit tests for src/contracts.js -- the builders behind GET /contracts,
// /contracts/player/:id, /contracts/summary and /config/cap. `get`/`getAll`
// are fake Supabase readers keyed on the table and filter in each request
// path. Rows mirror real nhl_contracts* rows (eyewall-pipeline's
// nhl_contracts.py, dataset 2026-10-24): Slavin's 2024 extension really is
// two rows (id-keyed tier B from the club, name-keyed tier E from archived
// CapFriendly) with different figures, and only the E row has a season
// breakdown.

import { describe, it, expect } from 'vitest'
import {
  buildTeamContracts, buildPlayerContracts, buildLeagueSummary, pickContract, seasonCapHit,
  seasonLabel, safeSeasonLabel, yearsLeftFor, coversSeason, shapeCapLimits, capLimitsFor, rosterPlayers,
  shapeDeadCap, summarizeDeadCap, readDeadCap, capSpaceEstimate, ESTIMATE_NOTES,
} from '../contracts.js'

const STAMP = '2026-10-24T12:08:21+00:00'
const SEASON = '2026-27'

const contract = (key, playerId, name, team, extra) => ({
  contract_key: key, player_id: playerId, player_name: name, team, signed_at: '2024-07-01', contract_type: 'standard',
  term_years: 8, aav_usd: null, cap_hit_usd: null, total_usd: null, one_way: true, start_season: '2024-25',
  end_season: '2031-32', expiry_status: null, expiry_type: 'UFA', expiry_type_derived: true, is_current: true,
  years_left: 5, n_sources: 1, best_tier: 'B', conflicts: null, flags: null, dataset_updated_at: STAMP, ...extra,
})

const AHO = contract('sebastian aho|CAR|2023-07', 8478427, 'Sebastian Aho', 'CAR', {
  aav_usd: 9_750_000, cap_hit_usd: 9_750_000, expiry_status: 'UFA', expiry_type_derived: false, best_tier: 'C', n_sources: 2,
})
const SLAVIN_B = contract('8476958|CAR|2024-07', 8476958, 'Jaccob Slavin', 'CAR', { aav_usd: 6_460_000, cap_hit_usd: 6_460_000 })
const SLAVIN_E = contract('jaccob slavin|CAR|2024-07', 8476958, 'Jaccob Slavin', 'CAR', {
  aav_usd: 6_396_063, cap_hit_usd: 6_396_063, start_season: '2025-26', end_season: '2029-30', years_left: 3, best_tier: 'E',
  expiry_status: 'UFA', expiry_type_derived: false,
})
// Signed by NJD, now on CAR's roster: only found through the roster ids.
const TRADED_IN = contract('8481234|NJD|2025-07', 8481234, 'Traded Forward', 'NJD', {
  aav_usd: 2_000_000, cap_hit_usd: 2_000_000, end_season: '2026-27', years_left: 0, expiry_type: 'RFA',
})
// Signed by CAR, off the roster (in the minors): found through team=eq.CAR.
const REILLY = contract('mike reilly|CAR|2026-09', 8476422, 'Mike Reilly', 'CAR', {
  aav_usd: 850_000, cap_hit_usd: 850_000, start_season: '2026-27', end_season: '2026-27', years_left: 0, best_tier: 'A',
  expiry_type: 'UFA',
})
const CONTRACTS = [AHO, SLAVIN_B, SLAVIN_E, TRADED_IN, REILLY]

const SEASONS = [
  { contract_key: 'jaccob slavin|CAR|2024-07', player_id: 8476958, team: 'CAR', season: '2026-27', cap_hit_usd: 6_396_063, aav_usd: 6_396_063, base_salary_usd: 7_000_000, signing_bonus_usd: null, performance_bonus_usd: null, total_salary_usd: 7_000_000, minors_salary_usd: null, one_way: true, clause: 'NMC', best_tier: 'E' },
  { contract_key: 'jaccob slavin|CAR|2024-07', player_id: 8476958, team: 'CAR', season: '2027-28', cap_hit_usd: 6_396_063, aav_usd: 6_396_063, base_salary_usd: 6_000_000, signing_bonus_usd: null, performance_bonus_usd: null, total_salary_usd: 6_000_000, minors_salary_usd: null, one_way: true, clause: 'NMC', best_tier: 'E' },
  { contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, team: 'CAR', season: '2026-27', cap_hit_usd: 9_750_000, aav_usd: 9_750_000, base_salary_usd: 9_750_000, signing_bonus_usd: null, performance_bonus_usd: null, total_salary_usd: 9_750_000, minors_salary_usd: null, one_way: true, clause: null, best_tier: 'E' },
]
const CLAUSES = [
  { contract_key: 'jaccob slavin|CAR|2024-07', player_id: 8476958, kind: 'NMC', season_from: '2025-26', season_to: '2029-30', list_size: null, list_type: null, best_tier: 'E' },
  { contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, kind: 'NMC', season_from: '2024-25', season_to: '2029-30', list_size: null, list_type: null, best_tier: 'E' },
  { contract_key: 'sebastian aho|CAR|2023-07', player_id: 8478427, kind: 'M-NTC', season_from: '2030-31', season_to: '2031-32', list_size: 10, list_type: 'no-trade', best_tier: 'E' },
]
const GAPS = [
  { player_id: 8482100, player_name: 'Alexander Nikishin', team: 'CAR', gap: 'no_contract', status: 'older_rows_only', last_contract_end: '2025-26' },
  { player_id: 8476958, player_name: 'Jaccob Slavin', team: 'CAR', gap: 'no_structure', status: 'has_contract', last_contract_end: '2031-32' },
]
const CAPS = [{ season: '2026-27', cap_ceiling: 104_000_000, cap_floor: 77_000_000, min_salary: 850_000, updated_at: STAMP }]

const player = (id, first, last, positionCode) => ({ id, firstName: { default: first }, lastName: { default: last }, positionCode })
const ROSTER = {
  forwards: [player(8478427, 'Sebastian', 'Aho', 'C'), player(8481234, 'Traded', 'Forward', 'L')],
  defensemen: [player(8476958, 'Jaccob', 'Slavin', 'D'), player(8482100, 'Alexander', 'Nikishin', 'D')],
  goalies: [],
}

// Fake Supabase: answers from the arrays above by table and filter.
// nhl_dead_cap rows for the season under test: a CAR retention (the trade
// post names the acquirer) and a CAR buyout charge; a null charge row too.
const DEAD_CAP = [
  { team: 'CAR', kind: 'retained', player_name: 'Retained Forward', player_id: 8470001, counterparty: 'TOR', season: '2026-27', cap_hit_usd: 1_500_000, pct: 50, contract_key: null, event_date: '2026-03-05', best_tier: 'D', flags: 'derived:charge_from_pct' },
  { team: 'CAR', kind: 'buyout', player_name: 'Bought Out', player_id: null, counterparty: null, season: '2026-27', cap_hit_usd: 1_100_000, pct: null, contract_key: null, event_date: null, best_tier: 'E', flags: 'team_page_dead_cap' },
  { team: 'CAR', kind: 'retained', player_name: 'No Figure', player_id: null, counterparty: null, season: '2026-27', cap_hit_usd: null, pct: 25, contract_key: null, event_date: null, best_tier: 'D', flags: 'charge_unknown' },
  { team: 'TOR', kind: 'buyout', player_name: 'Toronto Buyout', player_id: null, counterparty: null, season: '2026-27', cap_hit_usd: 2_000_000, pct: null, contract_key: null, event_date: null, best_tier: 'E', flags: '' },
  { team: 'CAR', kind: 'buyout', player_name: 'Last Year', player_id: null, counterparty: null, season: '2025-26', cap_hit_usd: 900_000, pct: null, contract_key: null, event_date: null, best_tier: 'E', flags: '' },
]

function fakeDb({ contracts = CONTRACTS, seasons = SEASONS, clauses = CLAUSES, gaps = GAPS, caps = CAPS, deadCap = DEAD_CAP } = {}) {
  const calls = []
  const ids = path => (path.match(/player_id=in\.\(([^)]*)\)/) || path.match(/player_id\.in\.\(([^)]*)\)/))?.[1]?.split(',').map(Number) || null
  const eqId = path => Number(path.match(/player_id=eq\.(\d+)/)?.[1]) || null
  const get = async (path) => {
    calls.push(path)
    if (path.startsWith('nhl_cap_limits?')) return caps
    if (path.startsWith('nhl_dead_cap?')) {
      if (deadCap === 'missing') throw new Error('relation "public.nhl_dead_cap" does not exist')
      const season = path.match(/season=eq\.([\d-]+)/)?.[1]
      const team = path.match(/team=eq\.([A-Z]+)/)?.[1]
      return deadCap.filter(r => r.season === season && (!team || r.team === team))
    }
    if (path.startsWith('nhl_contract_gaps?')) return gaps.filter(g => path.includes(`team=eq.${g.team}`))
    if (path.startsWith('nhl_contract_seasons?')) {
      const season = path.match(/season=eq\.([\d-]+)/)?.[1]
      const scoped = ids(path) || eqId(path)
      return seasons.filter(r => (!season || r.season === season) && (!scoped || (ids(path)?.includes(r.player_id) ?? eqId(path) === r.player_id)))
    }
    if (path.startsWith('nhl_contract_clauses?')) {
      return clauses.filter(r => ids(path)?.includes(r.player_id) ?? eqId(path) === r.player_id)
    }
    if (path.startsWith('nhl_contracts?')) {
      const team = path.match(/team\.eq\.([A-Z]+)/)?.[1] || path.match(/team=eq\.([A-Z]+)/)?.[1]
      const season = path.match(/start_season=lte\.([\d-]+)/)?.[1]
      const scoped = team || ids(path) || eqId(path)
      return contracts.filter(r =>
        (!season || coversSeason(r, season))
        && (!scoped || (eqId(path) ? r.player_id === eqId(path) : (r.team === team || (ids(path) || []).includes(r.player_id)))))
    }
    throw new Error(`unexpected path ${path}`)
  }
  return { get, getAll: get, calls }
}

describe('season helpers', () => {
  it('turns an NHL season id into a label and validates query labels', () => {
    expect(seasonLabel(20262027)).toBe('2026-27')
    expect(seasonLabel('2026-27')).toBe('2026-27')
    expect(seasonLabel('nope')).toBeNull()
    expect(safeSeasonLabel('2027-28')).toBe('2027-28')
    expect(safeSeasonLabel('2027-28)&x=1')).toBeNull()
    expect(safeSeasonLabel('')).toBeNull()
  })

  it('yearsLeftFor counts seasons after the asked one, never negative', () => {
    expect(yearsLeftFor('2031-32', '2026-27')).toBe(5)
    expect(yearsLeftFor('2026-27', '2026-27')).toBe(0)
    expect(yearsLeftFor('2022-23', '2026-27')).toBe(0)
    expect(yearsLeftFor(null, '2026-27')).toBeNull()
  })

  it('coversSeason needs a span', () => {
    expect(coversSeason(AHO, '2026-27')).toBe(true)
    expect(coversSeason(AHO, '2032-33')).toBe(false)
    expect(coversSeason({ ...AHO, start_season: null }, '2026-27')).toBe(false)
  })
})

describe('pickContract / seasonCapHit', () => {
  it('prefers the better tier, then more sources, then the id-keyed row', () => {
    expect(pickContract([SLAVIN_E, SLAVIN_B]).contract_key).toBe('8476958|CAR|2024-07')
    const twoC = [{ ...AHO, best_tier: 'C', n_sources: 1, contract_key: 'x|CAR|1' }, { ...AHO, best_tier: 'C', n_sources: 3, contract_key: 'y|CAR|1' }]
    expect(pickContract(twoC).contract_key).toBe('y|CAR|1')
    const sameAll = [{ ...AHO, contract_key: 'sebastian aho|CAR|2023-07' }, { ...AHO, contract_key: '8478427|CAR|2023-07' }]
    expect(pickContract(sameAll).contract_key).toBe('8478427|CAR|2023-07')
  })

  it('prefers the asked team over a better tier when told to', () => {
    const better = { ...TRADED_IN, best_tier: 'A' }
    expect(pickContract([better, { ...TRADED_IN, team: 'CAR', best_tier: 'C', contract_key: 'k' }], 'CAR').contract_key).toBe('k')
    expect(pickContract([better, { ...TRADED_IN, team: 'CAR', best_tier: 'C', contract_key: 'k' }]).contract_key).toBe(better.contract_key)
  })

  it('takes the cap hit from a season row before the contract row, best tier first', () => {
    expect(seasonCapHit(SLAVIN_B, SEASONS, '2026-27')).toEqual({ capHit: 6_396_063, source: 'season', tier: 'E' })
    const withB = [...SEASONS, { ...SEASONS[0], contract_key: '8476958|CAR|2024-07', cap_hit_usd: 6_460_000, best_tier: 'B' }]
    expect(seasonCapHit(SLAVIN_B, withB, '2026-27').capHit).toBe(6_460_000)
    expect(seasonCapHit(SLAVIN_B, SEASONS, '2030-31')).toEqual({ capHit: 6_460_000, source: 'contract', tier: 'B' })
    expect(seasonCapHit({ ...SLAVIN_B, cap_hit_usd: null }, [], '2026-27')).toEqual({ capHit: 6_460_000, source: 'aav', tier: 'B' })
    expect(seasonCapHit({ ...SLAVIN_B, cap_hit_usd: null, aav_usd: null }, [], '2026-27')).toEqual({ capHit: null, source: null, tier: null })
  })
})

describe('buildTeamContracts', () => {
  it('reads the roster players and the team-signed rows in one query, one row per player', async () => {
    const db = fakeDb()
    const out = await buildTeamContracts({ ...db, team: 'CAR', season: SEASON, roster: ROSTER })

    expect(db.calls[0]).toContain('nhl_contracts?')
    expect(db.calls[0]).toContain('or=(team.eq.CAR,player_id.in.(8478427,8481234,8476958,8482100))')
    expect(db.calls[0]).toContain('start_season=lte.2026-27&end_season=gte.2026-27')
    expect(out.rows.map(r => r.playerId)).toEqual([8478427, 8476958, 8481234, 8476422]) // roster first, cap hit desc
    expect(out.rows.filter(r => r.playerId === 8476958)).toHaveLength(1)
    expect(out.unavailable).toBe(false)
    expect(out.rosterKnown).toBe(true)
    expect(out.asOf).toBe(STAMP)
  })

  it("Slavin: the club's tier-B row for the contract, the archived row's season breakdown for the cap hit", async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    const slavin = out.rows.find(r => r.playerId === 8476958)
    expect(slavin).toMatchObject({
      contractKey: '8476958|CAR|2024-07', tier: 'B', official: true, expiresAfter: '2031-32', yearsLeft: 5,
      capHit: 6_396_063, capHitSource: 'season', capHitTier: 'E', aav: 6_460_000, position: 'D', onRoster: true, alternates: 1,
      expiryType: 'UFA', expiryTypeDerived: true,
    })
    expect(slavin.clauses).toEqual([{ kind: 'NMC', from: '2025-26', to: '2029-30', listSize: null, listType: null, tier: 'E' }])
  })

  it('finds a player traded in mid-contract through the roster and keeps the signing team on the row', async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.rows.find(r => r.playerId === 8481234)).toMatchObject({ team: 'NJD', onRoster: true, position: 'L', yearsLeft: 0, expiryType: 'RFA' })
  })

  it('lists team-signed players off the roster after the roster, with no position', async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.rows.at(-1)).toMatchObject({ playerId: 8476422, onRoster: false, position: null, tier: 'A' })
    expect(out.summary.offRosterCount).toBe(1)
  })

  it('names roster players with no public figure, with the dataset gap reason when it has one', async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.missing).toEqual([{ playerId: 8482100, name: 'Alexander Nikishin', position: 'D', gap: 'no_contract', status: 'older_rows_only' }])
  })

  it('summary: roster cap hit over roster players with a figure, cap limits, expiring by type', async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.summary).toEqual({
      rosterCapHit: 9_750_000 + 6_396_063 + 2_000_000,
      rosterCount: 4,
      rosterWithFigure: 3,
      rosterWithoutFigure: 1,
      offRosterCount: 1,
      capLimits: { ceiling: 104_000_000, floor: 77_000_000, minSalary: 850_000 },
      expiring: { ufa: 0, rfa: 1, unknown: 0 }, // Reilly expires too but is off the roster
      deadCap: { total: 2_600_000, retained: 1_500_000, buyouts: 1_100_000, count: 3 },
      capSpaceEstimate: 104_000_000 - (9_750_000 + 6_396_063 + 2_000_000) - 2_600_000,
      estimateNotes: ESTIMATE_NOTES,
    })
    expect(out.summary).not.toHaveProperty('space') // never "cap space": an estimate with caveats
  })

  it('asks for a different season: span filter, season rows and years left follow it', async () => {
    const db = fakeDb()
    const out = await buildTeamContracts({ ...db, team: 'CAR', season: '2027-28', roster: ROSTER })
    expect(db.calls[0]).toContain('start_season=lte.2027-28&end_season=gte.2027-28')
    expect(db.calls.find(c => c.startsWith('nhl_contract_seasons?'))).toContain('season=eq.2027-28')
    expect(out.rows.map(r => r.playerId)).toEqual([8478427, 8476958]) // the two one-year deals have ended
    expect(out.rows.find(r => r.playerId === 8476958)).toMatchObject({ yearsLeft: 4, capHit: 6_396_063, capHitSource: 'season' })
    expect(out.summary.capLimits).toBeNull() // 2027-28 not announced
  })

  it('without a roster reads only the team-signed rows and says so', async () => {
    const db = fakeDb()
    const out = await buildTeamContracts({ ...db, team: 'CAR', season: SEASON, roster: null })
    expect(db.calls[0]).toContain('&team=eq.CAR&')
    expect(db.calls[0]).not.toContain('or=')
    expect(out.rosterKnown).toBe(false)
    expect(out.rows.map(r => r.playerId)).toEqual([8478427, 8476958, 8476422])
    expect(out.rows.every(r => r.onRoster === false)).toBe(true)
    expect(out.missing).toEqual([])
    expect(out.summary.expiring).toEqual({ ufa: 1, rfa: 0, unknown: 0 }) // counted over every row when the roster is unknown
  })

  it('a team with no rows is unavailable (so the app hides the tab) but still lists who is missing', async () => {
    const out = await buildTeamContracts({ ...fakeDb({ contracts: [] }), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.unavailable).toBe(true)
    expect(out.rows).toEqual([])
    expect(out.missing).toHaveLength(4)
    expect(out.summary.rosterCapHit).toBe(0)
    expect(out.asOf).toBeNull()
  })
})

describe('buildPlayerContracts', () => {
  it('returns the history newest first with season rows, and the chosen current contract', async () => {
    const db = fakeDb()
    const out = await buildPlayerContracts({ get: db.get, playerId: '8476958', season: SEASON })
    expect(db.calls.every(c => c.includes('player_id=eq.8476958'))).toBe(true)
    expect(out.playerId).toBe(8476958)
    expect(out.history.map(h => h.contractKey)).toEqual(['8476958|CAR|2024-07', 'jaccob slavin|CAR|2024-07'])
    expect(out.history[1].seasons.map(s => s.season)).toEqual(['2026-27', '2027-28'])
    expect(out.history[1].seasons[0]).toMatchObject({ capHit: 6_396_063, baseSalary: 7_000_000, clause: 'NMC', tier: 'E' })
    expect(out.history[0].seasons).toEqual([])
    expect(out.history[0].yearsLeft).toBe(5) // the dataset's own years_left
    expect(out.current).toMatchObject({ contractKey: '8476958|CAR|2024-07', capHit: 6_396_063, capHitSource: 'season' })
    expect(out.current.clauses).toHaveLength(1)
    expect(out.unavailable).toBe(false)
  })

  it('no rows: unavailable, null current', async () => {
    const out = await buildPlayerContracts({ get: fakeDb({ contracts: [] }).get, playerId: '1', season: SEASON })
    expect(out).toMatchObject({ playerId: 1, current: null, history: [], unavailable: true, asOf: null })
  })

  it('current is null when no contract covers the season', async () => {
    const out = await buildPlayerContracts({ get: fakeDb().get, playerId: '8481234', season: '2030-31' })
    expect(out.current).toBeNull()
    expect(out.history).toHaveLength(1)
  })
})

describe('buildLeagueSummary', () => {
  it('groups by signing team, one contract per team-player, totals the season cap hits', async () => {
    const db = fakeDb()
    const out = await buildLeagueSummary({ ...db, season: SEASON })
    expect(db.calls[0]).toContain('nhl_contracts?')
    expect(db.calls[0]).not.toContain('team=eq.')
    expect(out.basis).toBe('signing_team')
    expect(out.capLimits).toEqual({ ceiling: 104_000_000, floor: 77_000_000, minSalary: 850_000 })
    expect(out.teams).toEqual([
      { team: 'CAR', contracts: 3, withFigure: 3, capHitTotal: 9_750_000 + 6_396_063 + 850_000, expiring: { ufa: 1, rfa: 0, unknown: 0 } },
      { team: 'NJD', contracts: 1, withFigure: 1, capHitTotal: 2_000_000, expiring: { ufa: 0, rfa: 1, unknown: 0 } },
    ])
    expect(out.unavailable).toBe(false)
  })

  it('empty tables: unavailable', async () => {
    const out = await buildLeagueSummary({ ...fakeDb({ contracts: [], seasons: [] }), season: SEASON })
    expect(out).toMatchObject({ teams: [], unavailable: true })
  })
})

describe('cap limits and roster shaping', () => {
  it('shapes nhl_cap_limits rows per season and finds one season', () => {
    expect(shapeCapLimits(CAPS, '2026-27')).toEqual({
      current: '2026-27',
      seasons: { '2026-27': { ceiling: 104_000_000, floor: 77_000_000, minSalary: 850_000 } },
    })
    expect(capLimitsFor(CAPS, '2027-28')).toBeNull()
    expect(shapeCapLimits([], '2026-27')).toEqual({ current: '2026-27', seasons: {} })
  })

  it('flattens a roster payload and skips entries without an id', () => {
    expect(rosterPlayers({ forwards: [player(1, 'A', 'B', 'C'), { firstName: { default: 'x' } }], goalies: [player(2, 'G', 'K', 'G')] })).toEqual([
      { id: 1, name: 'A B', position: 'C' },
      { id: 2, name: 'G K', position: 'G' },
    ])
    expect(rosterPlayers(null)).toEqual([])
  })
})


describe('dead cap and the cap-space estimate', () => {
  it('shapes a row and sums charges by kind, null charges counted but adding nothing', () => {
    const rows = DEAD_CAP.filter(r => r.team === 'CAR' && r.season === '2026-27').map(shapeDeadCap)
    expect(rows[0]).toEqual({
      team: 'CAR', kind: 'retained', playerName: 'Retained Forward', playerId: 8470001, counterparty: 'TOR', season: '2026-27',
      capHit: 1_500_000, pct: 50, contractKey: null, eventDate: '2026-03-05', tier: 'D', flags: ['derived:charge_from_pct'],
    })
    expect(summarizeDeadCap(rows)).toEqual({ total: 2_600_000, retained: 1_500_000, buyouts: 1_100_000, count: 3 })
    expect(summarizeDeadCap([])).toEqual({ total: 0, retained: 0, buyouts: 0, count: 0 })
    expect(summarizeDeadCap(undefined).total).toBe(0)
  })

  it('capSpaceEstimate needs every part', () => {
    expect(capSpaceEstimate(104_000_000, 88_000_000, 2_600_000)).toBe(13_400_000)
    expect(capSpaceEstimate(null, 88_000_000, 0)).toBeNull()
    expect(capSpaceEstimate(104_000_000, null, 0)).toBeNull()
    expect(capSpaceEstimate(104_000_000, 88_000_000, null)).toBeNull()
  })

  it('readDeadCap scopes by season and team, and returns null when the table cannot be read', async () => {
    const db = fakeDb()
    const rows = await readDeadCap(db.get, '2026-27', 'CAR')
    expect(rows.map(r => r.playerName)).toEqual(['Retained Forward', 'Bought Out', 'No Figure'])
    expect(db.calls.at(-1)).toContain('nhl_dead_cap?')
    expect(db.calls.at(-1)).toContain('season=eq.2026-27&team=eq.CAR')
    expect((await readDeadCap(db.get, '2026-27')).map(r => r.team)).toEqual(['CAR', 'CAR', 'CAR', 'TOR'])
    expect(await readDeadCap(fakeDb({ deadCap: 'missing' }).get, '2026-27', 'CAR')).toBeNull()
  })

  it('the team payload carries the rows, the totals and the estimate with its caveats', async () => {
    const out = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.deadCapKnown).toBe(true)
    expect(out.deadCap.map(r => r.kind)).toEqual(['retained', 'buyout', 'retained'])
    expect(out.summary.deadCap).toEqual({ total: 2_600_000, retained: 1_500_000, buyouts: 1_100_000, count: 3 })
    expect(out.summary.capSpaceEstimate).toBe(104_000_000 - out.summary.rosterCapHit - 2_600_000)
    expect(out.summary.estimateNotes).toEqual(ESTIMATE_NOTES)
    expect(ESTIMATE_NOTES).toContain('no_ltir')
  })

  it('without the table the team payload still answers, with no estimate', async () => {
    const out = await buildTeamContracts({ ...fakeDb({ deadCap: 'missing' }), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(out.deadCapKnown).toBe(false)
    expect(out.deadCap).toEqual([])
    expect(out.summary.deadCap).toBeNull()
    expect(out.summary.capSpaceEstimate).toBeNull()
    expect(out.summary.estimateNotes).toBeNull()
    expect(out.unavailable).toBe(false)
  })

  it('no estimate without a roster or a ceiling', async () => {
    const noRoster = await buildTeamContracts({ ...fakeDb(), team: 'CAR', season: SEASON, roster: null })
    expect(noRoster.summary.deadCap.total).toBe(2_600_000)
    expect(noRoster.summary.capSpaceEstimate).toBeNull()
    const noCap = await buildTeamContracts({ ...fakeDb({ caps: [] }), team: 'CAR', season: SEASON, roster: ROSTER })
    expect(noCap.summary.capSpaceEstimate).toBeNull()
  })
})
