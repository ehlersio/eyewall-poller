// src/__tests__/penaltyText.test.js
// Unit tests for src/penaltyText.js -- the readable penalty text pushes and
// the Live Activity share, matching eyewall-analytics' utils/penaltyText.js.

import { describe, it, expect } from 'vitest'
import { PENALTY_DESC, penaltyDescription, penaltyParties, penaltyParts, penaltyText } from '../penaltyText.js'
import { penaltyPlays, rosterSpots } from './fixtures/nhl-2025021237-penalties.js'

const fullNames = Object.fromEntries(rosterSpots.map(r => [r.playerId, `${r.firstName.default} ${r.lastName.default}`]))
const nameOf = id => fullNames[id] || null

describe('penaltyText', () => {
  it('reads a bench minor as the bench’s, served by the player in the box (2025021237, P1 17:25)', () => {
    const bench = penaltyPlays[0].details
    expect(penaltyParties(bench, nameOf)).toEqual({
      committedName: null, servedByName: 'Taylor Hall', teamPenalty: true, benchMinor: true,
    })
    expect(penaltyText(bench, nameOf)).toBe('Bench minor · Delay of game (unsuccessful challenge) · 2 min · served by Taylor Hall')
  })

  it('names the player who committed it, with no served-by of their own', () => {
    expect(penaltyPlays.slice(1).map(p => penaltyText(p.details, nameOf))).toEqual([
      'Mark Kastelic · Goaltender interference · 2 min',
      'Nikita Zadorov · Slashing · 2 min',
      'Charlie McAvoy · Cross-checking · 2 min',
      'David Pastrnak · High-sticking · 2 min',
      'Jordan Martinook · Interference · 2 min',
    ])
  })

  it('never guesses a name the roster doesn’t have', () => {
    // The bench minor with no roster: no served-by, and no stand-in name.
    expect(penaltyText(penaltyPlays[0].details, () => null)).toBe('Bench minor · Delay of game (unsuccessful challenge) · 2 min')
    // A player's own penalty with no roster: what and how long only.
    expect(penaltyParts(penaltyPlays[2].details, () => null)).toEqual(['Slashing', '2 min'])
  })

  it('says who serves a player’s penalty when someone else does', () => {
    // A goalie's minor, served by a skater (ids from the fixture's roster).
    const goalieMinor = { typeCode: 'MIN', descKey: 'tripping', duration: 2, committedByPlayerId: 8480355, servedByPlayerId: 8477507 }
    expect(penaltyText(goalieMinor, nameOf)).toBe('Mark Kastelic · Tripping · 2 min · served by Nikita Zadorov')
    // Served by the player who took it: nothing extra.
    expect(penaltyText({ ...goalieMinor, servedByPlayerId: 8480355 }, nameOf)).toBe('Mark Kastelic · Tripping · 2 min')
  })

  it('calls a non-minor penalty with no player a team penalty', () => {
    expect(penaltyText({ typeCode: 'BEN', descKey: 'unsportsmanlike-conduct-bench', duration: 10 }, nameOf))
      .toBe('Team penalty · Unsportsmanlike conduct (bench) · 10 min')
    // descKey 'bench' reads "Bench minor" too: said once.
    expect(penaltyText({ typeCode: 'BEN', descKey: 'bench', duration: 2 }, nameOf)).toBe('Bench minor · 2 min')
  })

  it('leaves out a duration the feed doesn’t give', () => {
    expect(penaltyParts({ typeCode: 'PS', descKey: 'ps-hooking-on-breakaway', duration: 0, committedByPlayerId: 8477956 }, nameOf))
      .toEqual(['David Pastrnak', 'Penalty shot (hooking on a breakaway)'])
  })

  it('doesn’t call a penalty the team’s just because its player hasn’t posted yet', () => {
    expect(penaltyParts({ typeCode: 'MIN', descKey: 'hooking', duration: 2 }, nameOf)).toEqual(['Hooking', '2 min'])
    expect(penaltyText({}, nameOf)).toBe('')
  })
})

describe('penaltyDescription', () => {
  it('carries the app’s 47 descriptions', () => {
    expect(Object.keys(PENALTY_DESC)).toHaveLength(47)
    expect(penaltyDescription('interference-goalkeeper')).toBe('Goaltender interference')
    expect(penaltyDescription('roughing-removing-opponents-helmet')).toBe("Roughing (removing an opponent's helmet)")
  })

  it('reads a key it doesn’t know as its own words, first letter capped', () => {
    expect(penaltyDescription('clipping')).toBe('Clipping')
    expect(penaltyDescription('delaying-game-smothering-puck')).toBe('Delaying game smothering puck')
    expect(penaltyDescription('toString')).toBe('ToString') // not Object.prototype's
  })

  it('is null with no descKey', () => {
    expect(penaltyDescription(undefined)).toBe(null)
    expect(penaltyDescription('')).toBe(null)
    expect(penaltyDescription(42)).toBe(null)
  })
})
