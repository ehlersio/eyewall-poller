// src/__tests__/probableStarters.test.js
// summarizeStarters() -- the shaping behind GET /probable-starters (see
// nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeStarters } from '../probableStarters.js'

const row = (team, goalie_id, goalie_name, start_prob, run_date = '2026-09-28', factors = { share_last10: 0.6 }) =>
  ({ team, goalie_id, goalie_name, start_prob, factors, game_date: '2026-09-29', run_date })

describe('summarizeStarters', () => {
  it('groups by team, most likely first, with the newest run date', () => {
    const out = summarizeStarters([
      row('CAR', 2, 'Backup', 0.3),
      row('FLA', 9, 'Starter', 0.8, '2026-09-29'),
      row('CAR', 1, 'Number One', 0.7),
      row('FLA', 8, 'Other', 0.2, '2026-09-29'),
    ])
    expect(out.gameDate).toBe('2026-09-29')
    expect(out.runDate).toBe('2026-09-29')
    expect(out.teams.CAR.map(g => g.goalie_id)).toEqual([1, 2])
    expect(out.teams.FLA.map(g => g.goalie_id)).toEqual([9, 8])
    expect(out.teams.CAR[0]).toEqual({ goalie_id: 1, goalie_name: 'Number One', start_prob: 0.7, factors: { share_last10: 0.6 } })
  })

  it('breaks probability ties by name and tolerates missing factors', () => {
    const out = summarizeStarters([row('SEA', 2, 'Grubauer', 0.44, undefined, undefined), row('SEA', 1, 'Daccord', 0.44)])
    expect(out.teams.SEA.map(g => g.goalie_name)).toEqual(['Daccord', 'Grubauer'])
    expect(summarizeStarters([{ ...row('SEA', 3, 'X', 1), factors: undefined }]).teams.SEA[0].factors).toBeNull()
  })

  it('handles no rows', () => {
    expect(summarizeStarters([])).toEqual({ gameDate: null, runDate: null, teams: {} })
    expect(summarizeStarters(null).teams).toEqual({})
  })
})
