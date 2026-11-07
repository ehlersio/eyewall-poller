// src/__tests__/tradeCandidacy.test.js
// summarizeCandidacy() / summarizeBoard() -- the shaping behind
// GET /trade-candidacy and /trade-candidacy/board (see
// nhl-routes.characterization.test.js for the routes themselves).

import { describe, it, expect } from 'vitest'
import { summarizeCandidacy, summarizeBoard } from '../tradeCandidacy.js'

const row = (id, rank, extra = {}) => ({
  player_id: id, season: 20262027, team: 'CHI', name: `Player ${id}`, position: 'L', games_played: 38,
  tier: 'several', rank, model_p: 0.31,
  signals: [{ code: 'expiring', expiry_type: 'UFA', derived: false }, { code: 'outside_playoffs', conference: 'W', conference_rank: 14, line: 8 }],
  cap_hit: 3300000, years_left: 0, expiry_type: 'UFA', expiry_type_derived: false, extended: false,
  clause_kind: null, clause_list_size: null, as_of: '2027-01-15', deadline: '2027-03-01',
  generated_at: '2027-01-15T08:00:00Z', ...extra,
})

describe('summarizeCandidacy', () => {
  it('shapes a tiered player and never passes the model number on', () => {
    const out = summarizeCandidacy(row(1, 3, { clause_kind: 'M-NTC', clause_list_size: 10 }))
    expect(out).toMatchObject({ asOf: '2027-01-15', deadline: '2027-03-01', generatedAt: '2027-01-15T08:00:00Z' })
    expect(out.player).toMatchObject({ id: 1, tier: 'several', rank: 3, capHit: 3300000, expiryType: 'UFA', extended: false })
    expect(out.player.clause).toEqual({ kind: 'M-NTC', listSize: 10 })
    expect(out.player.signals.map(s => s.code)).toEqual(['expiring', 'outside_playoffs'])
    expect(JSON.stringify(out)).not.toContain('model')
  })

  it('hides untiered players, players without a signal, and missing rows', () => {
    const empty = { player: null, ai: null, asOf: null, deadline: null, generatedAt: null }
    expect(summarizeCandidacy(row(1, null, { tier: null }))).toEqual(empty)
    expect(summarizeCandidacy(row(1, 1, { signals: [] }))).toEqual(empty)
    expect(summarizeCandidacy(undefined)).toEqual(empty)
  })
})

describe('summarizeCandidacy: the EyeWall AI paragraph', () => {
  const ai = (extra = {}) => ({ paragraph: '  Player 1 has several signals.  ', season: 20262027, generated_at: '2027-01-15T09:00:00Z', ...extra })

  it('attaches the paragraph, trimmed, with when it was written', () => {
    expect(summarizeCandidacy(row(1, 3), ai()).ai).toEqual({ text: 'Player 1 has several signals.', generatedAt: '2027-01-15T09:00:00Z' })
  })

  it('is null without a row, when empty, or from another season', () => {
    expect(summarizeCandidacy(row(1, 3)).ai).toBeNull()
    expect(summarizeCandidacy(row(1, 3), ai({ paragraph: '   ' })).ai).toBeNull()
    expect(summarizeCandidacy(row(1, 3), ai({ paragraph: null })).ai).toBeNull()
    expect(summarizeCandidacy(row(1, 3), ai({ season: 20252026 })).ai).toBeNull()
  })

  it('is never shown for a player who has no section', () => {
    expect(summarizeCandidacy(row(1, null, { tier: null }), ai()).ai).toBeNull()
  })
})

describe('summarizeBoard', () => {
  it('ranks tiered players and drops the rest', () => {
    const out = summarizeBoard([row(2, 2, { tier: 'some' }), row(1, 1), row(3, null, { tier: null })])
    expect(out.players.map(p => p.id)).toEqual([1, 2])
    expect(out.players[1].tier).toBe('some')
    expect(out).toMatchObject({ asOf: '2027-01-15', deadline: '2027-03-01', fitTeam: null })
    expect(out.players[0]).not.toHaveProperty('fit')
  })

  it("attaches one team's fit tier when asked", () => {
    const out = summarizeBoard([row(1, 1), row(2, 2)], [{ player_id: 2, tier: 'strong' }], 'CAR')
    expect(out.fitTeam).toBe('CAR')
    expect(out.players.map(p => p.fit)).toEqual([null, 'strong'])
  })

  it('an empty table is an empty board', () => {
    expect(summarizeBoard([])).toEqual({ players: [], asOf: null, deadline: null, generatedAt: null, fitTeam: null })
  })
})


describe('summarizeCandidacy: clause status', () => {
  it('the player carries the season\'s status; the board does not read it', () => {
    const row = {
      player_id: 1, season: 20262027, team: 'CAR', name: 'A', position: 'C', games_played: 40, tier: 'some', rank: 3,
      signals: [{ code: 'expiring' }], cap_hit: 3_000_000, years_left: 0, clause_kind: null,
    }
    const status = [{ contract_key: 'k', season: '2026-27', status: 'none_likely', basis: 'breakdown_without_clause' }]
    expect(summarizeCandidacy(row, null, status).player.clauseStatus).toEqual({ status: 'none_likely', basis: 'breakdown_without_clause' })
    expect(summarizeCandidacy(row).player.clauseStatus).toBeNull()
    expect(summarizeBoard([row]).players[0].clauseStatus).toBeNull()
  })
})
