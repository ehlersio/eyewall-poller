// src/__tests__/scratches.test.js
// Unit tests for src/scratches.js's summarizeScratches() -- rolling
// game_scratches rows up into a per-player summary for GET /scratches.

import { describe, it, expect } from 'vitest'
import { summarizeScratches } from '../scratches.js'

const row = (game_id, game_date, player_id, player_name, scratch_type) =>
  ({ game_id, game_date, player_id, player_name, scratch_type })

describe('summarizeScratches', () => {
  it('counts each player by scratch type and tracks their latest scratch', () => {
    const { players } = summarizeScratches([
      row(1, '2026-10-10', 8476422, 'Mike Reilly', 'healthy'),
      row(2, '2026-10-12', 8476422, 'Mike Reilly', 'healthy'),
      row(3, '2026-10-14', 8476422, 'Mike Reilly', 'injured'),
    ])
    expect(players).toEqual([{
      player_id: 8476422, player_name: 'Mike Reilly',
      total: 3, healthy: 2, injured: 1, suspended: 0, unknown: 0, last_date: '2026-10-14',
    }])
  })

  it('sorts most-scratched first, then by healthy scratches', () => {
    const { players } = summarizeScratches([
      row(1, '2026-10-10', 1, 'A', 'injured'), row(2, '2026-10-12', 1, 'A', 'injured'),
      row(1, '2026-10-10', 2, 'B', 'healthy'), row(2, '2026-10-12', 2, 'B', 'healthy'),
      row(1, '2026-10-10', 3, 'C', 'healthy'),
    ])
    expect(players.map(p => p.player_name)).toEqual(['B', 'A', 'C'])
  })

  it('totals the team, counts distinct games, and flags whether anything is classified', () => {
    const summary = summarizeScratches([
      row(1, '2025-12-13', 10, 'X', 'unknown'),
      row(1, '2025-12-13', 11, 'Y', 'unknown'),
      row(2, '2025-12-15', 10, 'X', 'unknown'),
    ])
    expect(summary.totals).toEqual({ healthy: 0, injured: 0, suspended: 0, unknown: 3 })
    expect(summary.games_with_scratches).toBe(2)
    expect(summary.classified).toBe(false)
    expect(summarizeScratches([row(1, '2026-10-10', 10, 'X', 'healthy')]).classified).toBe(true)
  })

  it('treats an unrecognized scratch_type as unknown and skips rows without a player_id', () => {
    const summary = summarizeScratches([
      row(1, '2026-10-10', 10, 'X', 'something-new'),
      row(1, '2026-10-10', null, 'Nobody', 'healthy'),
    ])
    expect(summary.players).toHaveLength(1)
    expect(summary.players[0].unknown).toBe(1)
  })

  it('handles empty or missing input', () => {
    expect(summarizeScratches(null)).toEqual({
      players: [], totals: { healthy: 0, injured: 0, suspended: 0, unknown: 0 },
      games_with_scratches: 0, classified: false,
    })
  })
})
