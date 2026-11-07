// src/__tests__/tradeFit.test.js
// summarizeTradeFit() -- the shaping behind GET /trade-fit (see
// nhl-routes.characterization.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeTradeFit } from '../tradeFit.js'

const playerRow = {
  player_id: 8480023, season: 20262027, team: 'STL', name: 'Robert Thomas', position: 'C', shoots: 'R',
  rating: 1.3402, rating_basis: 'last_season', games_played: 16, cap_hit: 8125000, years_left: 4,
  expires_after: '2030-31', expiry_type: 'UFA', expiry_type_derived: false, rental: false,
  clause_kind: 'M-NTC', clause_list_size: 10, generated_at: '2026-11-07T08:00:00Z',
}
const fit = (team, rank, extra = {}) => ({
  team, rank, tier: 'strong', slot: 'F_TOP6_C', gap: 0.5, need_met: true, window_met: true,
  cap_state: 'fits', reasons: [{ code: 'need_upgrade', slot: 'F_TOP6_C', gap: 0.5, slot_need: false }], ...extra,
})

describe('summarizeTradeFit', () => {
  it('maps the player and ranks the teams', () => {
    const out = summarizeTradeFit(playerRow, [fit('NYI', 2), fit('DET', 1), fit('BOS', 3, { tier: 'long_shot', slot: null, gap: null, need_met: false, window_met: true, cap_state: 'needs_salary' })])
    expect(out.generatedAt).toBe('2026-11-07T08:00:00Z')
    expect(out.player).toMatchObject({ id: 8480023, team: 'STL', ratingBasis: 'last_season', capHit: 8125000, yearsLeft: 4, rental: false })
    expect(out.player.clause).toEqual({ kind: 'M-NTC', listSize: 10 })
    expect(out.teams.map(t => t.team)).toEqual(['DET', 'NYI', 'BOS'])
    expect(out.teams[2]).toMatchObject({ tier: 'long_shot', slot: null, gap: null, needMet: false, windowMet: true, capState: 'needs_salary' })
    expect(out.teams[0].reasons[0].code).toBe('need_upgrade')
  })

  it('no clause on record is null, not "none"', () => {
    const out = summarizeTradeFit({ ...playerRow, clause_kind: null, clause_list_size: null }, [])
    expect(out.player.clause).toBeNull()
    expect(out.teams).toEqual([])
  })

  it('a player outside the population has no fit', () => {
    expect(summarizeTradeFit(null, [fit('DET', 1)])).toEqual({ player: null, teams: [], generatedAt: null })
    expect(summarizeTradeFit(undefined, undefined)).toEqual({ player: null, teams: [], generatedAt: null })
  })

  it('passes the phase and rights through, in season by default', () => {
    expect(summarizeTradeFit(playerRow, []).player).toMatchObject({ phase: 'in_season', rights: false })
    const off = summarizeTradeFit({ ...playerRow, season: 20272028, phase: 'offseason', rights: true, cap_hit: null, years_left: null }, [
      fit('DET', 1, { tier: 'possible', window_met: false, cap_state: 'unknown', reasons: [{ code: 'window_rights', expiry_type: 'UFA' }, { code: 'cap_unannounced', season: '2027-28' }] }),
    ])
    expect(off.player).toMatchObject({ season: 20272028, phase: 'offseason', rights: true, capHit: null })
    expect(off.teams[0].reasons.map(r => r.code)).toEqual(['window_rights', 'cap_unannounced'])
    expect(summarizeTradeFit({ ...playerRow, phase: 'something' }, []).player.phase).toBe('in_season')
  })

  it('tolerates missing reasons', () => {
    expect(summarizeTradeFit(playerRow, [fit('DET', 1, { reasons: null })]).teams[0].reasons).toEqual([])
  })
})
