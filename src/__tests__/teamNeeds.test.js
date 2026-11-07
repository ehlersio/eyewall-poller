// src/__tests__/teamNeeds.test.js
// summarizeTeamNeeds() -- the shaping behind GET /team-needs (see
// nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeTeamNeeds } from '../teamNeeds.js'

const meta = { season: 20262027, generated_at: '2026-11-06T08:00:00Z' }
const row = (slot, extra = {}) => ({
  slot,
  players: [],
  n_players: 0,
  n_rated: 0,
  strength: null,
  weakest_id: null,
  weakest_rating: null,
  league_rank: null,
  league_teams: 32,
  need: false,
  right_shots: null,
  basis: 'last_game',
  basis_game_id: 2026020200,
  ...meta,
  ...extra,
})

describe('summarizeTeamNeeds', () => {
  it('orders slots forwards, D, goalies and maps players', () => {
    const out = summarizeTeamNeeds([
      row('G_1A', { basis: 'goalie_starts', basis_game_id: null, players: [{ id: 50, name: 'G', pos: 'G', shoots: 'L', rating: 0.7, rating_basis: 'season', gp: 11, filled: false, games_started: 11 }] }),
      row('D_TOP4', {
        players: [{ id: 1, name: 'A', pos: 'D', shoots: 'R', rating: 0.5, rating_basis: 'last_season', gp: 18, filled: true }],
        n_players: 1, n_rated: 1, strength: 0.5, weakest_id: 1, weakest_rating: 0.5,
        league_rank: 27, need: true, right_shots: 1,
      }),
      row('F_TOP6_C'),
    ])
    expect(out).toMatchObject({ season: 20262027, basis: 'last_game', basisGameId: 2026020200, generatedAt: '2026-11-06T08:00:00Z' })
    expect(out.slots.map(s => s.slot)).toEqual(['F_TOP6_C', 'D_TOP4', 'G_1A'])
    const d = out.slots[1]
    expect(d).toMatchObject({ strength: 0.5, leagueRank: 27, leagueTeams: 32, need: true, rightShots: 1, weakestId: 1 })
    expect(d.players[0]).toEqual({ id: 1, name: 'A', pos: 'D', shoots: 'R', rating: 0.5, ratingBasis: 'last_season', gp: 18, filled: true })
    expect(out.slots[2].players[0]).toMatchObject({ gamesStarted: 11, ratingBasis: 'season' })
    expect(out.slots[2].basis).toBe('goalie_starts')
  })

  it('keeps unrated players unrated and unknown slots last', () => {
    const out = summarizeTeamNeeds([
      row('X_NEW'),
      row('F_BOT6_W', { players: [{ id: 9 }] }),
    ])
    expect(out.slots.map(s => s.slot)).toEqual(['F_BOT6_W', 'X_NEW'])
    expect(out.slots[0].players[0]).toEqual({ id: 9, name: '9', pos: null, shoots: null, rating: null, ratingBasis: null, gp: 0, filled: false })
    expect(out.slots[0].nPlayers).toBe(0)
  })

  it('reads the projection basis off a skater slot, not a goalie one', () => {
    const out = summarizeTeamNeeds([row('G_1A', { basis: 'goalie_starts' })])
    expect(out.basis).toBeNull()
    expect(out.season).toBe(20262027)
  })

  it('handles no rows', () => {
    const empty = { season: null, basis: null, basisGameId: null, generatedAt: null, slots: [] }
    expect(summarizeTeamNeeds([])).toEqual(empty)
    expect(summarizeTeamNeeds(null)).toEqual(empty)
  })
})
