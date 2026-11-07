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
    expect(new Set(items[0].ids)).toEqual(new Set([1, 2]))
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
      kind: 'move', id: 1, date: '2025-12-31', team: 'PIT', category: 'trade',
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

describe('provenance (eyewall-pipeline wiki_trades.py)', () => {
  const WIKI_PHI = {
    ...PHI_HALF, id: 7, source: 'wikipedia', source_url: 'https://www.nhl.com/news/x', date_status: null,
    description: 'Acquired Philip Tomasino from the Pittsburgh Penguins for Yegor Zamula.',
  }

  it('passes source, citation and date status through, only when set', () => {
    const [item] = pairTransactions([{ ...PIT_HALF, source: 'espn', source_url: null, date_status: null }, WIKI_PHI])
    const phi = item.sides.find(s => s.team === 'PHI')
    expect(phi).toEqual({ team: 'PHI', description: WIKI_PHI.description, source: 'wikipedia', sourceUrl: 'https://www.nhl.com/news/x' })
    expect(item.sides.find(s => s.team === 'PIT')).toEqual({ team: 'PIT', description: PIT_HALF.description })
    expect(item.dateStatus).toBeUndefined()
  })

  it('dates a pair from the half that is not an unconfirmed ESPN date', () => {
    const early = { ...PIT_HALF, tx_date: '2023-02-23', date_status: 'espn_early' }
    const corrected = { ...PHI_HALF, tx_date: '2023-02-24', date_status: 'corrected', source_url: 'u' }
    const [item] = pairTransactions([early, corrected])
    expect(item.date).toBe('2023-02-24')
    expect(item.dateStatus).toBeUndefined()
    const [both] = pairTransactions([early, { ...PHI_HALF, tx_date: '2023-02-23', date_status: 'espn_early' }])
    expect(both.dateStatus).toBe('espn_early')
  })

  it('flags a single move from the early window', () => {
    const [move] = pairTransactions([{ ...RECALL, date_status: 'espn_early' }])
    expect(move.dateStatus).toBe('espn_early')
  })
})
