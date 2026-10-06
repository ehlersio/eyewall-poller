// src/__tests__/pwhl-standings-streak.test.js
// /pwhl/standings' L10 and streak on the real 2025-26 game log. An OT/SO
// loss (pwhl_game_log.ot / .shootout) is its own 'OT' result, as for the
// AHL/ECHL and the NHL -- before 2026-10 it extended an 'L' streak, so
// Minnesota (OT loss in its last game after three regulation losses) read
// L4 instead of OT1, and HockeyTech's own standings still say "4L".

import { describe, expect, it, vi } from 'vitest'
import { makeEnv, makeCtx, makeRequest } from './route-harness.js'
import { gameLog, teamSeasons } from './fixtures/pwhl-2025-26-game-log.js'
import { endedInOf, gameResult } from '../hockeytechPrediction.js'
import { handlePWHL } from '../pwhl.js'

async function standings() {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('pwhl_team_seasons')) return { ok: true, json: async () => teamSeasons }
    if (u.includes('pwhl_game_log')) return { ok: true, json: async () => gameLog }
    throw new Error(`unexpected fetch: ${u}`)
  })
  const res = await handlePWHL(
    makeRequest('/pwhl/standings?season=8'), makeEnv(), makeCtx(),
    new URL('https://example.com/pwhl/standings?season=8'),
  )
  expect(res.status).toBe(200)
  return res.json()
}

describe('endedInOf', () => {
  it('reads PWHL ot/shootout flags and AHL/ECHL ended_in', () => {
    expect(endedInOf({ ot: true, shootout: false })).toBe('OT')
    expect(endedInOf({ ot: false, shootout: true })).toBe('SO')
    expect(endedInOf({ ot: false, shootout: false })).toBeNull()
    expect(endedInOf({ ended_in: 'SO' })).toBe('SO')
    expect(endedInOf({ ended_in: null })).toBeNull()
  })

  it('counts each team\'s OT/SO losses the same as pwhl_team_seasons.ot_losses', () => {
    const otl = {}
    for (const g of gameLog) {
      for (const [tid, my, op] of [[g.home_team_id, g.home_score, g.away_score], [g.away_team_id, g.away_score, g.home_score]]) {
        if (gameResult(my, op, endedInOf(g)) === 'OT') otl[tid] = (otl[tid] || 0) + 1
      }
    }
    for (const r of teamSeasons) expect(otl[r.team_id] || 0).toBe(r.ot_losses)
  })
})

describe('GET /pwhl/standings L10 and streak (2025-26)', () => {
  it('splits OT/SO losses from regulation losses', async () => {
    const rows = await standings()
    const pick = ({ team_id, l10W, l10L, l10OTL, streakType, streakCount }) => ({ team_id, l10W, l10L, l10OTL, streakType, streakCount })
    expect(rows.map(pick)).toEqual([
      { team_id: 1, l10W: 7, l10L: 1, l10OTL: 2, streakType: 'W', streakCount: 1 },
      { team_id: 3, l10W: 8, l10L: 1, l10OTL: 1, streakType: 'W', streakCount: 1 },
      // MIN: OT, L, L, L -- was L4.
      { team_id: 2, l10W: 3, l10L: 5, l10OTL: 2, streakType: 'OT', streakCount: 1 },
      { team_id: 5, l10W: 7, l10L: 3, l10OTL: 0, streakType: 'W', streakCount: 4 },
      // TOR: L, OT -- was L2.
      { team_id: 6, l10W: 4, l10L: 5, l10OTL: 1, streakType: 'L', streakCount: 1 },
      { team_id: 9, l10W: 5, l10L: 5, l10OTL: 0, streakType: 'W', streakCount: 4 },
      { team_id: 4, l10W: 4, l10L: 6, l10OTL: 0, streakType: 'L', streakCount: 1 },
      // SEA: OT, W -- was L1.
      { team_id: 8, l10W: 3, l10L: 4, l10OTL: 3, streakType: 'OT', streakCount: 1 },
    ])
  })

  it('keeps every row\'s season record as stored', async () => {
    const rows = await standings()
    expect(rows.map(({ team_id, wins, losses, ot_losses, points }) => ({ team_id, wins, losses, ot_losses, points }))).toEqual(
      teamSeasons.map(({ team_id, wins, losses, ot_losses, points }) => ({ team_id, wins, losses, ot_losses, points })),
    )
  })
})
