// src/__tests__/trades.test.js
// Unit tests for src/trades.js -- shaping trades / trade_assets rows and
// walking next_trade_id links for GET /trades/tree. `get` is a fake
// Supabase reader keyed on the table + filter in each request path. Rows
// mirror real 2025-26 trades (eyewall-pipeline's trade_trees.py output).

import { describe, it, expect } from 'vitest'
import { fetchTradeTree, shapeAsset, shapeTrade } from '../trades.js'

const T1 = 'aaaaaaaaaaaaaaaa' // 2025-01-31 VAN <-> NYR (J.T. Miller)
const T2 = 'bbbbbbbbbbbbbbbb' // 2025-02-01 VAN <-> PIT (the pick moves on)
const T3 = 'cccccccccccccccc' // 2025-03-07 NYR <-> BUF (Brannstrom moves on)
const T0 = 'dddddddddddddddd' // earlier trade that brought Chytil to NYR

const trade = (id, date, teams) => ({ trade_id: id, tx_date: date, teams, via: [], descriptions: [`${teams[0]} desc`] })
const asset = (tid, idx, from, to, extra) => ({
  trade_id: tid, idx, from_team: from, to_team: to, asset_type: 'player', next_trade_id: null, ...extra,
})

const TRADES = {
  [T1]: trade(T1, '2025-01-31', ['NYR', 'VAN']),
  [T2]: trade(T2, '2025-02-01', ['PIT', 'VAN']),
  [T3]: trade(T3, '2025-03-07', ['BUF', 'NYR']),
  [T0]: trade(T0, '2024-06-28', ['NYR', 'SJS']),
}
const ASSETS = [
  asset(T1, 0, 'VAN', 'NYR', { player_name: 'JT Miller', position: 'C', player_id: 8476468 }),
  asset(T1, 1, 'VAN', 'NYR', { player_name: 'Erik Brannstrom', position: 'D', next_trade_id: T3 }),
  asset(T1, 2, 'NYR', 'VAN', { player_name: 'Filip Chytil', position: 'C' }),
  asset(T1, 3, 'NYR', 'VAN', {
    asset_type: 'pick', pick_year: 2025, pick_round: 1, pick_conditional: true, pick_raw: 'a conditional 2025 first round draft pick',
    resolved_year: 2025, resolved_overall: 12, drafted_player_name: 'Porter Martone', drafted_player_id: 8484000, next_trade_id: T2,
  }),
  asset(T2, 0, 'PIT', 'VAN', { player_name: 'Marcus Pettersson', position: 'D' }),
  asset(T2, 1, 'VAN', 'PIT', { asset_type: 'pick', pick_year: 2025, pick_round: 1, resolved_year: 2025, resolved_overall: 12 }),
  asset(T3, 0, 'NYR', 'BUF', { player_name: 'Erik Brannstrom', position: 'D' }),
  asset(T3, 1, 'BUF', 'NYR', { asset_type: 'future_considerations' }),
  asset(T0, 0, 'SJS', 'NYR', { player_name: 'Filip Chytil', next_trade_id: T1 }),
]

function fakeGet() {
  const calls = []
  const get = async (path) => {
    calls.push(path)
    const ids = (path.match(/in\.\(([^)]*)\)/)?.[1] || '').split(',')
    if (path.startsWith('trades?') && path.includes('source_tx_ids=cs.%7B42%7D')) return [TRADES[T1]]
    if (path.startsWith('trades?') && path.includes('source_tx_ids')) return []
    if (path.startsWith('trades?')) return ids.map(id => TRADES[id]).filter(Boolean)
    if (path.includes('next_trade_id=eq.')) {
      const id = path.split('next_trade_id=eq.')[1]
      return ASSETS.filter(a => a.next_trade_id === id)
    }
    return ASSETS.filter(a => ids.includes(a.trade_id))
  }
  return { get, calls }
}

describe('shapeAsset / shapeTrade', () => {
  it('shapes players, resolved picks and considerations', () => {
    expect(shapeAsset(ASSETS[0])).toEqual({
      type: 'player', from: 'VAN', to: 'NYR', next: null, name: 'JT Miller', position: 'C', rights: false, playerId: 8476468,
    })
    expect(shapeAsset(ASSETS[3]).pick).toMatchObject({
      year: 2025, round: 1, conditional: true, resolvedOverall: 12, draftedName: 'Porter Martone', note: null,
    })
    expect(shapeAsset(ASSETS[7])).toEqual({ type: 'future_considerations', from: 'BUF', to: 'NYR', next: null })
  })

  it('splits assets into one side per team, in idx order', () => {
    const t = shapeTrade(TRADES[T1], [ASSETS[2], ASSETS[0], ASSETS[3], ASSETS[1]])
    expect(t.sides.map(s => s.team)).toEqual(['NYR', 'VAN'])
    expect(t.sides[0].received.map(a => a.name)).toEqual(['JT Miller', 'Erik Brannstrom'])
    expect(t.sides[1].received.map(a => a.type)).toEqual(['player', 'pick'])
  })
})

describe('fetchTradeTree', () => {
  it('walks next-trade links from the trade holding the transaction', async () => {
    const { get } = fakeGet()
    const tree = await fetchTradeTree('42', get)
    expect(tree.found).toBe(true)
    expect(tree.root).toBe(T1)
    expect(Object.keys(tree.trades).sort()).toEqual([T1, T2, T3])
    const van = tree.trades[T1].sides.find(s => s.team === 'VAN')
    expect(van.received.find(a => a.type === 'pick').next).toBe(T2)
    expect(tree.trades[T3].sides.find(s => s.team === 'NYR').received[0].type).toBe('future_considerations')
    expect(tree.truncated).toBe(false)
  })

  it('loads origins: the trades that brought in what the root sent out', async () => {
    const { get } = fakeGet()
    const tree = await fetchTradeTree('42', get)
    expect(tree.origins).toEqual([{ id: T0, date: '2024-06-28', teams: ['NYR', 'SJS'], assets: [shapeAsset(ASSETS[8])] }])
  })

  it('stops at the depth / size limits and says so', async () => {
    const { get } = fakeGet()
    const tree = await fetchTradeTree('42', get, { maxDepth: 1 })
    expect(Object.keys(tree.trades)).toEqual([T1])
    expect(tree.truncated).toBe(true)
    const small = await fetchTradeTree('42', fakeGet().get, { maxTrades: 2 })
    expect(Object.keys(small.trades)).toEqual([T1])
    expect(small.truncated).toBe(true)
  })

  it('returns found: false when no trade holds the transaction', async () => {
    const { get, calls } = fakeGet()
    expect(await fetchTradeTree('7', get)).toEqual({ found: false, root: null, trades: {}, origins: [], truncated: false })
    expect(calls).toHaveLength(1)
  })

  it('never puts a malformed trade id into a filter', async () => {
    const bad = 'x),id.gt.(0'
    const calls = []
    const get = async (path) => {
      calls.push(path)
      if (path.includes('source_tx_ids')) return [TRADES[T1]]
      if (path.startsWith('trade_assets') && path.includes('in.(')) return [{ ...ASSETS[0], next_trade_id: bad }]
      return []
    }
    const tree = await fetchTradeTree('42', get)
    expect(calls.some(p => p.includes(bad))).toBe(false)
    expect(Object.keys(tree.trades)).toEqual([T1])
  })
})
