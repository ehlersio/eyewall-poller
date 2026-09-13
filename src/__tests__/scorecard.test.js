// src/__tests__/scorecard.test.js
// summarizeScorecard() -- the grouping behind GET /scorecard (see
// nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeScorecard } from '../scorecard.js'

const row = (model, kind, period, extra = {}) => ({
  model, kind, period, status: 'ok', n: 10, accuracy: 0.6, brier: 0.24, updated_at: '2026-10-10T12:00:00Z', ...extra,
})

describe('summarizeScorecard', () => {
  it('groups live and backtest rows per model', () => {
    const out = summarizeScorecard([
      row('game_winner', 'live', '2026-27'),
      row('game_winner', 'backtest', '2023-24 to 2025-26'),
      row('starting_goalie', 'live', '2026-27', { status: 'pending', n: 0 }),
    ])
    expect(Object.keys(out.models).sort()).toEqual(['game_winner', 'starting_goalie'])
    expect(out.models.game_winner.live.period).toBe('2026-27')
    expect(out.models.game_winner.backtest.period).toBe('2023-24 to 2025-26')
    expect(out.models.starting_goalie.backtest).toBeNull()
  })

  it("keeps each model's most recent live period", () => {
    const out = summarizeScorecard([
      row('playoff_odds', 'live', '2026-27', { n: 0 }),
      row('playoff_odds', 'live', '2025-26', { n: 384 }),
    ])
    expect(out.models.playoff_odds.live).toMatchObject({ period: '2026-27', n: 0 })
  })

  it('ignores unknown models and kinds, and reports the newest updated_at kept', () => {
    const out = summarizeScorecard([
      row('game_winner', 'live', '2026-27', { updated_at: '2026-10-11T12:00:00Z' }),
      row('game_winner', 'backtest', '2023-24 to 2025-26', { updated_at: '2026-09-13T12:00:00Z' }),
      row('mystery', 'live', '2026-27', { updated_at: '2030-01-01T00:00:00Z' }),
      row('game_winner', 'draft', '2026-27', { updated_at: '2030-01-01T00:00:00Z' }),
    ])
    expect(Object.keys(out.models)).toEqual(['game_winner'])
    expect(out.updatedAt).toBe('2026-10-11T12:00:00Z')
  })

  it('handles no rows', () => {
    expect(summarizeScorecard([])).toEqual({ models: {}, updatedAt: null })
    expect(summarizeScorecard(null)).toEqual({ models: {}, updatedAt: null })
  })
})
