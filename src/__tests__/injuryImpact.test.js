// src/__tests__/injuryImpact.test.js
// summarizeInjuryLeague() -- the league averages behind GET /injury-impact
// (see nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeInjuryLeague } from '../injuryImpact.js'

describe('summarizeInjuryLeague', () => {
  it('averages man-games, WAR lost and games played across teams', () => {
    const rows = [
      { team: 'CAR', games_played: 10, man_games_lost: 14, war_lost: 0.62 },
      { team: 'OTT', games_played: 9, man_games_lost: 6, war_lost: 0.18 },
      { team: 'BOS', games_played: 11, man_games_lost: 0, war_lost: 0 },
    ]
    expect(summarizeInjuryLeague(rows)).toEqual({ teams: 3, avgManGames: 6.7, avgWarLost: 0.267, avgGamesPlayed: 10 })
  })

  it('treats missing values as zero, and handles no rows', () => {
    expect(summarizeInjuryLeague([{ team: 'CAR', games_played: 4, man_games_lost: null, war_lost: undefined }]))
      .toEqual({ teams: 1, avgManGames: 0, avgWarLost: 0, avgGamesPlayed: 4 })
    expect(summarizeInjuryLeague([])).toEqual({ teams: 0, avgManGames: null, avgWarLost: null, avgGamesPlayed: null })
    expect(summarizeInjuryLeague(null).teams).toBe(0)
  })
})
