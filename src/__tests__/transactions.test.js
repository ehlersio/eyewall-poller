// src/__tests__/transactions.test.js
// Unit tests for src/transactions.js's pairTransactions() -- merging the
// two per-team halves of an ESPN trade entry into one feed item. Example
// descriptions are verbatim from ESPN's live feed.

import { describe, it, expect } from 'vitest'
import { pairTransactions } from '../transactions.js'

const PIT_HALF = {
  id: 1, tx_date: '2025-12-31', team: 'PIT', categories: ['trade'], primary_category: 'trade', counterparties: ['PHI'],
  description: 'Acquired D Yegor Zamula from Philadelphia in exchange for F Philip Tomasino.',
}
const PHI_HALF = {
  id: 2, tx_date: '2025-12-31', team: 'PHI', categories: ['trade'], primary_category: 'trade', counterparties: ['PIT'],
  description: 'Acquired F Philip Tomasino from Pittsburgh Penguins for D Yegor Zamula.',
}
const RECALL = {
  id: 3, tx_date: '2026-01-02', team: 'CHI', categories: ['recall'], primary_category: 'recall', counterparties: [],
  description: 'Recalled F Dominic Toninato from Rockford (AHL).',
}

describe('pairTransactions', () => {
  it('merges the two halves of a same-day trade into one item', () => {
    const items = pairTransactions([PIT_HALF, PHI_HALF])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('trade')
    expect(items[0].date).toBe('2025-12-31')
    expect(new Set(items[0].teams)).toEqual(new Set(['PIT', 'PHI']))
    expect(items[0].sides.map(s => s.description)).toContain(PHI_HALF.description)
  })

  it('puts the focus team first in a pair', () => {
    expect(pairTransactions([PIT_HALF, PHI_HALF], { focusTeam: 'PHI' })[0].teams).toEqual(['PHI', 'PIT'])
    expect(pairTransactions([PIT_HALF, PHI_HALF], { focusTeam: 'PIT' })[0].teams).toEqual(['PIT', 'PHI'])
  })

  it('pairs halves posted up to two days apart, but not three', () => {
    const lateTwo   = { ...PHI_HALF, tx_date: '2026-01-02' }
    const lateThree = { ...PHI_HALF, tx_date: '2026-01-03' }
    expect(pairTransactions([PIT_HALF, lateTwo])).toHaveLength(1)
    expect(pairTransactions([PIT_HALF, lateThree])).toHaveLength(2)
  })

  it('leaves a trade with no matching other half as a single move with its counterparties', () => {
    const items = pairTransactions([PIT_HALF])
    expect(items).toEqual([{
      kind: 'move', date: '2025-12-31', team: 'PIT', category: 'trade',
      categories: ['trade'], counterparties: ['PHI'], description: PIT_HALF.description,
    }])
  })

  it('does not pair trades between different teams', () => {
    const otherTrade = { ...PHI_HALF, id: 9, team: 'NSH', counterparties: ['OTT'] }
    expect(pairTransactions([PIT_HALF, otherTrade]).every(i => i.kind === 'move')).toBe(true)
  })

  it('uses each row at most once when a team posts two trades with the same partner', () => {
    const secondPit = { ...PIT_HALF, id: 4 }
    const items = pairTransactions([PIT_HALF, PHI_HALF, secondPit])
    expect(items.filter(i => i.kind === 'trade')).toHaveLength(1)
    expect(items.filter(i => i.kind === 'move')).toHaveLength(1)
  })

  it('returns newest first and passes non-trade rows through', () => {
    const items = pairTransactions([PIT_HALF, RECALL, PHI_HALF])
    expect(items.map(i => i.kind)).toEqual(['move', 'trade'])
    expect(items[0]).toMatchObject({ team: 'CHI', category: 'recall' })
  })

  it('tolerates empty/missing input and rows without categories', () => {
    expect(pairTransactions(null)).toEqual([])
    expect(pairTransactions([{ id: 5, tx_date: '2026-01-01', team: 'CAR', description: 'x' }])[0].category).toBe('other')
  })
})
