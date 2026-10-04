import { describe, expect, it } from 'vitest'

import { buildCallupWatch, matchProspects, movesNaming, nameKey, positionGroup } from '../callupWatch.js'

const ahl = (player_id, first_name, last_name, position, birth_date = null) =>
  ({ player_id, first_name, last_name, position, birth_date, jersey_number: null })
const prospect = (id, first, last, birthDate, positionCode = 'C') =>
  ({ id, firstName: { default: first }, lastName: { default: last }, birthDate, positionCode })
const skaterSeason = (player_id, season_id, gp, points) =>
  ({ player_id, season_id, gp, goals: Math.floor(points / 2), assists: points - Math.floor(points / 2), points })

describe('nameKey / positionGroup', () => {
  it('compares names without accents, case or punctuation', () => {
    expect(nameKey('Felix Unger Sörum')).toBe(nameKey('Felix Unger Sorum'))
    expect(nameKey('Skyler Brind’Amour')).toBe(nameKey("Skyler Brind'Amour"))
    expect(nameKey('Charles-Alexis Legault')).toBe(nameKey('Charles Alexis Legault'))
  })

  it('groups positions into F, D and G', () => {
    expect(['C', 'LW', 'RW', 'F', 'L', 'R', 'D', 'LD', 'G', '', null].map(positionGroup))
      .toEqual(['F', 'F', 'F', 'F', 'F', 'F', 'D', 'D', 'G', null, null])
  })
})

describe('matchProspects', () => {
  it('matches on birth date + last name, so first-name spellings can differ', () => {
    const m = matchProspects(
      [ahl(1, 'Charles-Alexis', 'Legault', 'D', '2003-09-05'), ahl(2, 'Felix', 'Unger Sörum', 'RW', '2005-09-14')],
      [prospect(10, 'Charles Alexis', 'Legault', '2003-09-05', 'D'), prospect(20, 'Felix', 'Unger Sorum', '2005-09-14', 'R')],
    )
    expect(m.get(1).id).toBe(10)
    expect(m.get(2).id).toBe(20)
  })

  it('falls back to the full name without a birth date, and never matches a namesake born another day', () => {
    const m = matchProspects(
      [ahl(1, 'Joel', 'Nystrom', 'D'), ahl(2, 'Ryan', 'Smith', 'C', '2001-01-01')],
      [prospect(10, 'Joel', 'Nyström', '2002-05-14'), prospect(20, 'Tom', 'Smith', '1999-03-03')],
    )
    expect(m.get(1).id).toBe(10)
    expect(m.has(2)).toBe(false)
  })
})

describe('movesNaming', () => {
  it('finds a player in multi-name entries, accent-blind', () => {
    const tx = [
      { tx_date: '2026-04-14', description: 'Recalled Ds Ronan Seeley and Joel Nystrom from Chicago (AHL).' },
      { tx_date: '2026-03-01', description: 'Recalled F Bradly Nadeau from Chicago (AHL).' },
    ]
    expect(movesNaming(ahl(1, 'Joel', 'Nyström', 'D'), tx).map(t => t.tx_date)).toEqual(['2026-04-14'])
    expect(movesNaming(ahl(2, 'Bradly', 'Nadeau', 'C'), tx)).toHaveLength(1)
  })
})

describe('buildCallupWatch', () => {
  const base = () => ({
    team: 'CAR',
    currentSeason: 94,
    previousSeason: 90,
    injuries: [
      { player_id: 100, player_name: 'Seth Jarvis', status: 'injured-reserve', injury_type: 'Shoulder', return_date: '2026-10-24' },
      { player_id: null, player_name: 'Hurt Assignee', status: 'injured-reserve', injury_type: 'Knee' },
      { player_id: null, player_name: 'Mystery Player', status: 'out' },
    ],
    nhlPositions: { 100: 'R' },
    nhlPositionsByName: {},
    nhlRoster: [prospect(500, 'Pyotr', 'Kochetkov', '1999-06-25', 'G')],
    prospects: [
      prospect(1, 'Bradly', 'Nadeau', '2005-05-05', 'C'),
      prospect(2, 'Justin', 'Robidas', '2003-03-13', 'C'),
      prospect(3, 'Rookie', 'Fresh', '2006-01-01', 'C'),
    ],
    ahlPlayers: [
      ahl(11, 'Bradly', 'Nadeau', 'C', '2005-05-05'),
      ahl(12, 'Justin', 'Robidas', 'C', '2003-03-13'),
      ahl(13, 'Rookie', 'Fresh', 'C', '2006-01-01'),
      ahl(14, 'Veteran', 'Assignee', 'LW', '1995-01-01'),
      ahl(15, 'Hurt', 'Assignee', 'D', '1996-01-01'),
      ahl(16, 'Pyotr', 'Kochetkov', 'G', '1999-06-25'),
      ahl(17, 'Ahl', 'Contract', 'RW', '1998-01-01'), // no rights, no moves: not listed
    ],
    skaterSeasons: [
      skaterSeason(11, 90, 53, 56), skaterSeason(11, 94, 2, 1),
      skaterSeason(12, 90, 59, 60), skaterSeason(12, 94, 2, 3),
      skaterSeason(13, 94, 2, 4), // only 2 GP: below the ranking bar
      skaterSeason(14, 90, 69, 34),
      skaterSeason(15, 90, 40, 20),
    ],
    goalieSeasons: [],
    skaterBox: [
      { game_id: 9, player_id: 12, goals: 1, assists: 1, points: 2 },
      { game_id: 9, player_id: 11, goals: 0, assists: 0, points: 0 },
      { game_id: 8, player_id: 12, goals: 0, assists: 1, points: 1 },
      { game_id: 8, player_id: 11, goals: 1, assists: 0, points: 1 },
    ],
    goalieBox: [],
    transactions: [
      { tx_date: '2026-09-25', description: 'Placed F Veteran Assignee on waivers.', categories: ['waivers'] },
      { tx_date: '2026-03-01', description: 'Recalled F Bradly Nadeau from Chicago (AHL).', categories: ['recall'] },
    ],
  })

  it("lists who's out by position, and keeps an unknown position out of the groups", () => {
    const w = buildCallupWatch(base())
    expect(w.groups.F.out).toEqual([{ playerId: 100, name: 'Seth Jarvis', status: 'injured-reserve', injuryType: 'Shoulder', returnDate: '2026-10-24' }])
    expect(w.unplaced.map(u => u.name)).toEqual(['Mystery Player'])
  })

  it('treats an injured player on the affiliate as hurt there, not an open NHL spot or a candidate', () => {
    const w = buildCallupWatch(base())
    expect(w.groups.D.out).toEqual([])
    expect(w.groups.D.hurt.map(h => h.name)).toEqual(['Hurt Assignee'])
    expect(w.groups.D.candidates).toEqual([])
  })

  it('ranks by points per game over both seasons; players under 5 GP go last, unranked', () => {
    const f = buildCallupWatch(base()).groups.F.candidates
    expect(f.map(c => [c.name, c.ranked])).toEqual([
      ['Bradly Nadeau', true], // 57 / 55 = 1.04
      ['Justin Robidas', true], // 63 / 61 = 1.03
      ['Veteran Assignee', true], // 34 / 69 = 0.49
      ['Rookie Fresh', false],
    ])
    expect(f[0].combined).toEqual({ gp: 55, points: 57, pointsPerGame: 1.04 })
    expect(f[0].current).toMatchObject({ gp: 2, points: 1 })
    expect(f[0].previous).toMatchObject({ gp: 53, points: 56 })
    expect(f[0].metric).toBeUndefined()
  })

  it('carries last games, recalls, rights and the latest move', () => {
    const f = buildCallupWatch(base()).groups.F.candidates
    const nadeau = f.find(c => c.name === 'Bradly Nadeau')
    expect(nadeau).toMatchObject({ holdsRights: true, nhlPlayerId: 1, lastGames: { gp: 2, points: 1 } })
    expect(nadeau.recalls).toEqual([{ date: '2026-03-01', description: 'Recalled F Bradly Nadeau from Chicago (AHL).' }])
    const vet = f.find(c => c.name === 'Veteran Assignee')
    expect(vet).toMatchObject({ holdsRights: false, recalls: [], lastMove: { date: '2026-09-25', description: 'Placed F Veteran Assignee on waivers.' } })
  })

  it('lists an affiliate player on the NHL roster now as up, not a candidate; leaves out AHL-only players', () => {
    const w = buildCallupWatch(base())
    expect(w.groups.G.upNow.map(u => u.name)).toEqual(['Pyotr Kochetkov'])
    expect(w.groups.G.candidates).toEqual([])
    expect(Object.values(w.groups).flatMap(g => g.candidates).some(c => c.name === 'Ahl Contract')).toBe(false)
  })

  it('ranks goalies by save percentage over both seasons', () => {
    const p = base()
    p.ahlPlayers.push(ahl(21, 'Goalie', 'One', 'G'), ahl(22, 'Goalie', 'Two', 'G'))
    p.prospects.push(prospect(31, 'Goalie', 'One', null, 'G'), prospect(32, 'Goalie', 'Two', null, 'G'))
    p.goalieSeasons = [
      { player_id: 21, season_id: 90, gp: 30, saves: 900, shots_against: 1000, goals_against: 100 },
      { player_id: 22, season_id: 90, gp: 30, saves: 920, shots_against: 1000, goals_against: 80 },
    ]
    p.goalieBox = [{ game_id: 9, player_id: 21, saves: 28, shots_against: 30, goals_against: 2, toi_seconds: 3600 }]
    const g = buildCallupWatch(p).groups.G.candidates
    expect(g.map(c => [c.name, c.combined.svPct])).toEqual([['Goalie Two', 0.92], ['Goalie One', 0.9]])
    expect(g[1].lastGames).toEqual({ gp: 1, svPct: 0.933 })
  })
})
