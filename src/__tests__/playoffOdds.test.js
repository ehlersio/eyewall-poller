// src/__tests__/playoffOdds.test.js
// summarizeNextGames() / isPlayoffOddsStale() -- the shaping behind
// GET /playoff-odds (see nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeNextGames, isPlayoffOddsStale, NEXT_GAMES_OTHERS } from '../playoffOdds.js'

const row = (game_id, home_team, away_team, outcome, playoff_pct) =>
  ({ game_id, game_date: '2026-10-16', home_team, away_team, outcome, playoff_pct })

describe('summarizeNextGames', () => {
  it('pairs the two outcomes of each game into one entry', () => {
    const out = summarizeNextGames([row(1, 'CAR', 'OTT', 'home', 0.66), row(1, 'CAR', 'OTT', 'away', 0.57)], 'CAR')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ game_id: 1, home: 'CAR', away: 'OTT', ifHomeWins: 0.66, ifAwayWins: 0.57, own: true })
    expect(out[0].swing).toBeCloseTo(0.09)
  })

  it("puts the team's own games first, then other games by biggest swing", () => {
    const rows = [
      row(2, 'NYR', 'BOS', 'home', 0.62), row(2, 'NYR', 'BOS', 'away', 0.60),
      row(3, 'NJD', 'PIT', 'home', 0.70), row(3, 'NJD', 'PIT', 'away', 0.61),
      row(1, 'OTT', 'CAR', 'home', 0.57), row(1, 'OTT', 'CAR', 'away', 0.66),
    ]
    expect(summarizeNextGames(rows, 'CAR').map(g => g.game_id)).toEqual([1, 3, 2])
  })

  it('drops other games that barely move the odds, and caps how many are kept', () => {
    const rows = [row(9, 'MTL', 'TOR', 'home', 0.641), row(9, 'MTL', 'TOR', 'away', 0.643)]
    for (let id = 10; id < 10 + NEXT_GAMES_OTHERS + 2; id++) {
      rows.push(row(id, 'NYR', 'BOS', 'home', 0.60 + id / 1000), row(id, 'NYR', 'BOS', 'away', 0.55))
    }
    const out = summarizeNextGames(rows, 'CAR')
    expect(out).toHaveLength(NEXT_GAMES_OTHERS)
    expect(out.some(g => g.game_id === 9)).toBe(false)
  })

  it('drops a game missing an outcome, and handles no rows', () => {
    expect(summarizeNextGames([row(1, 'CAR', 'OTT', 'home', 0.66)], 'CAR')).toEqual([])
    expect(summarizeNextGames(null, 'CAR')).toEqual([])
  })
})

describe('isPlayoffOddsStale', () => {
  const at = iso => Date.parse(iso)
  it('is fresh for the next few days after a run, stale after that', () => {
    expect(isPlayoffOddsStale('2026-10-15', at('2026-10-15T20:00:00Z'))).toBe(false)
    expect(isPlayoffOddsStale('2026-10-15', at('2026-10-18T10:00:00Z'))).toBe(false)
    expect(isPlayoffOddsStale('2026-10-15', at('2026-10-18T13:00:00Z'))).toBe(true)
    expect(isPlayoffOddsStale('2027-04-16', at('2027-08-01T12:00:00Z'))).toBe(true)
  })
})
