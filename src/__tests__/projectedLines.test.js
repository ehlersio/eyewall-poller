// src/__tests__/projectedLines.test.js
// summarizeProjectedLines() -- the shaping behind GET /projected-lines (see
// nhl-routes.test.js for the route itself).

import { describe, it, expect } from 'vitest'
import { summarizeProjectedLines } from '../projectedLines.js'

const meta = { basis: 'last_game', basis_game_id: 2026020100, basis_games: 1, generated_at: '2026-11-02T08:00:00Z' }
const unit = (unit_type, rank, player_ids, positions, filled_ids = []) =>
  ({ unit_type, rank, player_ids, names: player_ids.map(id => `P${id}`), positions, filled_ids, ...meta })

describe('summarizeProjectedLines', () => {
  it('splits forwards and D, ranks them, orders forwards L-C-R, marks filled players', () => {
    const out = summarizeProjectedLines([
      unit('F', 2, [4, 5, 6], ['R', 'C', 'L']),
      unit('D', 1, [21, 22], ['D', 'D'], [22]),
      unit('F', 1, [1, 2, 3], ['C', 'RW', 'LW'], [3]),
    ])
    expect(out).toMatchObject({ basis: 'last_game', basisGameId: 2026020100, basisGames: 1, generatedAt: '2026-11-02T08:00:00Z' })
    expect(out.lines.map(l => l.rank)).toEqual([1, 2])
    expect(out.lines[0].players.map(p => p.pos)).toEqual(['LW', 'C', 'RW'])
    expect(out.lines[1].players.map(p => p.id)).toEqual([6, 5, 4])
    expect(out.lines[0].players.find(p => p.id === 3)).toEqual({ id: 3, name: 'P3', pos: 'LW', filled: true })
    expect(out.pairs[0].players.map(p => p.filled)).toEqual([false, true])
  })

  it('falls back to the id for a missing name and tolerates missing arrays', () => {
    const out = summarizeProjectedLines([{ ...unit('D', 1, [21, 22], ['D', 'D']), names: ['Known'], filled_ids: null }])
    expect(out.pairs[0].players.map(p => p.name)).toEqual(['Known', '22'])
    expect(summarizeProjectedLines([{ ...meta, unit_type: 'F', rank: 1 }]).lines[0].players).toEqual([])
  })

  it('handles no rows', () => {
    const empty = { basis: null, basisGameId: null, basisGames: null, generatedAt: null, lines: [], pairs: [] }
    expect(summarizeProjectedLines([])).toEqual(empty)
    expect(summarizeProjectedLines(null)).toEqual(empty)
  })
})
