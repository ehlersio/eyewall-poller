// src/__tests__/hockeytech-prediction.test.js
// Unit tests for hockeytechPrediction.js's pure helpers: which season is
// "last regular season" for each league, and how a team_seasons row turns
// into prompt stats. The routes themselves are covered in
// pwhl-routes.test.js and ahl-routes.test.js.

import { describe, expect, it } from 'vitest'
import { priorRegularSeason, teamPredictionStats } from '../hockeytechPrediction.js'

describe('priorRegularSeason', () => {
  // getAllPWHLSeasons(): non-hidden seasons only, no start dates. The
  // current preseason (10) is hidden, so it isn't in the list at all.
  const PWHL = [
    { seasonId: 1, seasonType: 'regular', startYear: 2024 },
    { seasonId: 3, seasonType: 'playoffs', startYear: 2024 },
    { seasonId: 5, seasonType: 'regular', startYear: 2024 },
    { seasonId: 6, seasonType: 'playoffs', startYear: 2025 },
    { seasonId: 8, seasonType: 'regular', startYear: 2025 },
    { seasonId: 9, seasonType: 'playoffs', startYear: 2026 },
    { seasonId: 11, seasonType: 'regular', startYear: 2026 },
  ]
  it('PWHL: the highest regular-season id below the current one', () => {
    expect(priorRegularSeason(PWHL, 11)).toEqual({ seasonId: 8, label: '2025-26 regular season' })
    expect(priorRegularSeason(PWHL, 10)).toEqual({ seasonId: 8, label: '2025-26 regular season' }) // hidden preseason
    expect(priorRegularSeason(PWHL, 9)).toEqual({ seasonId: 8, label: '2025-26 regular season' }) // playoffs
    expect(priorRegularSeason(PWHL, 8)).toEqual({ seasonId: 5, label: '2024-25 regular season' })
  })

  // getAllECHLSeasons(), real rows (2026-09-29): the preseason starts in
  // June, before the playoffs end.
  const ECHL = [
    { seasonId: 78, seasonType: 'regular', startYear: 2026, startDate: '2026-10-15' },
    { seasonId: 77, seasonType: 'preseason', startYear: 2026, startDate: '2026-06-23' },
    { seasonId: 76, seasonType: 'playoffs', startYear: 2026, startDate: '2026-04-21' },
    { seasonId: 75, seasonType: 'allstar', startYear: 2026, startDate: '2026-01-19' },
    { seasonId: 73, seasonType: 'regular', startYear: 2025, startDate: '2025-10-15' },
    { seasonId: 72, seasonType: 'preseason', startYear: 2025, startDate: '2025-06-23' },
    { seasonId: 70, seasonType: 'regular', startYear: 2024, startDate: '2024-10-17' },
  ]
  it('AHL/ECHL: the latest regular season that started before the current one', () => {
    expect(priorRegularSeason(ECHL, 78)).toEqual({ seasonId: 73, label: '2025-26 regular season' })
    expect(priorRegularSeason(ECHL, 77)).toEqual({ seasonId: 73, label: '2025-26 regular season' })
    expect(priorRegularSeason(ECHL, 76)).toEqual({ seasonId: 73, label: '2025-26 regular season' })
    expect(priorRegularSeason(ECHL, 73)).toEqual({ seasonId: 70, label: '2024-25 regular season' })
  })

  it('null when there is no earlier regular season or no season list', () => {
    expect(priorRegularSeason(PWHL, 1)).toBeNull()
    expect(priorRegularSeason(ECHL, 70)).toBeNull()
    expect(priorRegularSeason(null, 11)).toBeNull()
  })
})

describe('teamPredictionStats', () => {
  it('reads pp_pct/pk_pct as 0-1 fractions and PWHL Corsi as a percentage', () => {
    const row = { gp: 30, goals_for: 78, goals_against: 60, pp_pct: 0.193, pk_pct: 0.918, pp_opportunities: 83, times_shorthanded: 85, corsi_for_pct: 52.5, corsi_for_pct_5v5: 51.7 }
    const s = teamPredictionStats(row, undefined, { corsi: true })
    expect(s.pp.value).toBeCloseTo(19.3)
    expect(s.pk.value).toBeCloseTo(91.8)
    expect(s.cf5.value).toBe(51.7)
    expect(s.cfAll.value).toBe(52.5)
    expect(s.gf.value).toBeCloseTo(2.6)
  })

  it('a 0-GP row, a null column, or no power plays is missing -- never 0', () => {
    const zero = { gp: 0, goals_for: 0, goals_against: 0, pp_pct: 0, pk_pct: 0, pp_opportunities: 0, times_shorthanded: 0 }
    expect(teamPredictionStats(zero, undefined)).toEqual({ gp: 0, gf: null, ga: null, pp: null, pk: null })
    const noPP = { gp: 5, goals_for: null, goals_against: 10, pp_pct: 0, pk_pct: null, pp_opportunities: 0, times_shorthanded: 8 }
    const s = teamPredictionStats(noPP, undefined)
    expect(s.gf).toBeNull()
    expect(s.pp).toBeNull()
    expect(s.pk).toBeNull()
    expect(s.ga.value).toBe(2)
  })

  it('a real 0% (power plays but no goals) is kept', () => {
    const s = teamPredictionStats({ gp: 30, pp_pct: 0, pp_opportunities: 12 }, undefined)
    expect(s.pp.value).toBe(0)
  })
})
