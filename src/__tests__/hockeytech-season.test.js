// AHL/ECHL "current season" (seasons.js's pickHockeyTechSeason), against
// the leagues' real season lists as of 2026-09-28.
import { describe, expect, it } from 'vitest'
import { pickHockeyTechSeason } from '../seasons.js'

const s = (season_id, season_name, start_date, end_date, career, playoff) =>
  ({ season_id, season_name, start_date, end_date, career, playoff })

const AHL = [
  s('94', '2026-27 Regular Season', '2026-10-02', '2027-04-11', '1', '0'),
  s('93', '2026 Preseason', '2026-09-21', '2026-09-30', '0', '0'),
  s('92', '2026 Calder Cup Playoffs', '2026-04-20', '2026-06-20', '1', '1'),
  s('91', '2026 All-Star Challenge', '2026-02-10', '2026-02-12', '0', '0'),
  s('90', '2025-26 Regular Season', '2025-10-07', '2026-04-19', '1', '0'),
]
const ECHL = [
  s('78', '2026-27 Regular Season', '2026-10-15', '2027-04-11', '1', '0'),
  s('77', '2026 Preseason', '2026-06-23', '2026-10-14', '0', '0'),
  s('76', '2026 Kelly Cup Playoffs', '2026-04-21', '2026-06-17', '1', '1'),
  s('75', '2026 All-Star Game', '2026-01-19', '2026-01-20', '0', '0'),
  s('73', '2025-26 Regular Season', '2025-10-15', '2026-04-19', '1', '0'),
]
const id = (list, day) => pickHockeyTechSeason(list, day)?.season_id

describe('pickHockeyTechSeason', () => {
  it('in the offseason, after the playoffs: last regular season, so every team has stats', () => {
    expect(id(AHL, '2026-09-28')).toBe('90')
    expect(id(ECHL, '2026-09-28')).toBe('73')
  })

  it('during the playoffs: the playoffs', () => {
    expect(id(AHL, '2026-05-10')).toBe('92')
    expect(id(ECHL, '2026-06-17')).toBe('76') // last day still counts
  })

  it('a week past the playoffs’ listed end, in case the final runs late', () => {
    expect(id(ECHL, '2026-06-24')).toBe('76') // listed end + 7 days
    expect(id(ECHL, '2026-06-25')).toBe('73')
  })

  it('the new regular season from its first day', () => {
    expect(id(AHL, '2026-10-02')).toBe('94')
    expect(id(ECHL, '2026-10-15')).toBe('78')
  })

  it('never a preseason or all-star event (not career seasons)', () => {
    expect(id(AHL, '2026-09-25')).toBe('90')
  })

  it('nothing started: null, for the caller’s fallback', () => {
    expect(pickHockeyTechSeason(AHL, '2020-01-01')).toBeNull()
  })
})
