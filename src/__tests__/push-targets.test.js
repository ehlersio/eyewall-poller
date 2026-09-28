// Who gets a team's alert (shared.js): one-team and several-team
// subscriptions, per-team alert choices, and one alert -- not two -- for
// someone following both teams in a game.
import { describe, expect, it } from 'vitest'
import { pushTargets, subTeams } from '../shared.js'

const legacy = (teamAbbr, prefs = null) => ({ endpoint: `https://push.example/${teamAbbr}`, teamAbbr, prefs })
const multi = (id, teams) => ({ endpoint: `https://push.example/${id}`, teamAbbr: teams[0].key, prefs: teams[0].prefs, teams })

describe('subTeams', () => {
  it('reads an older one-team subscription as a one-team list', () => {
    expect(subTeams(legacy('PWHL:MIN', { goal: false }))).toEqual([{ key: 'PWHL:MIN', prefs: { goal: false } }])
  })

  it('treats a subscription with no team at all as the original NHL:CAR one', () => {
    expect(subTeams({ endpoint: 'x' })).toEqual([{ key: 'NHL:CAR', prefs: null }])
  })
})

describe('pushTargets', () => {
  it('keeps working for one-team subscriptions', () => {
    const subs = [legacy('NHL:CAR'), legacy('NHL:BOS'), legacy('NHL:CAR', { goal: false })]
    expect(pushTargets(subs, 'NHL:CAR', 'goal')).toEqual([subs[0]])
  })

  it('reaches every team a subscription follows, each with its own choices', () => {
    const fan = multi('fan', [
      { key: 'NHL:CAR', prefs: { goal: true } },
      { key: 'PWHL:MIN', prefs: { goal: false } },
      { key: 'AHL:HER', prefs: null },
    ])
    expect(pushTargets([fan], 'NHL:CAR', 'goal')).toEqual([fan])
    expect(pushTargets([fan], 'PWHL:MIN', 'goal')).toEqual([])
    expect(pushTargets([fan], 'AHL:HER', 'goal')).toEqual([fan])
    expect(pushTargets([fan], 'NHL:TOR', 'goal')).toEqual([])
  })

  it('an alert type a team’s choices don’t mention is on', () => {
    const fan = multi('fan', [{ key: 'NHL:CAR', prefs: { goal: false } }])
    expect(pushTargets([fan], 'NHL:CAR', 'periodEnd')).toEqual([fan])
  })

  it('following both teams in a game: one alert, from the higher team’s side', () => {
    const carFirst = multi('car-first', [{ key: 'NHL:CAR', prefs: null }, { key: 'NHL:BOS', prefs: null }])
    const bosFirst = multi('bos-first', [{ key: 'NHL:BOS', prefs: null }, { key: 'NHL:CAR', prefs: null }])
    const pair = ['NHL:CAR', 'NHL:BOS']
    expect(pushTargets([carFirst, bosFirst], 'NHL:CAR', 'goal', pair)).toEqual([carFirst])
    expect(pushTargets([carFirst, bosFirst], 'NHL:BOS', 'oppGoal', pair)).toEqual([bosFirst])
  })

  it('without the game’s pair, falls back to sending for each team', () => {
    const both = multi('both', [{ key: 'NHL:CAR', prefs: null }, { key: 'NHL:BOS', prefs: null }])
    expect(pushTargets([both], 'NHL:BOS', 'goal')).toEqual([both])
  })
})
