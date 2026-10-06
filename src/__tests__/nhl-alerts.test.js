// src/__tests__/nhl-alerts.test.js
// NHL push alerts replayed from real play-by-play (audit 2026-10-05, #1,
// #9, #10, #11, #29, #30, #31). Each fixture is a real api-web.nhle.com
// play-by-play, trimmed to the fields the Worker reads (fixtures/
// nhl-<gameId>-pbp.json). poll() is run tick by tick against the feed as
// it stood after a given play: the scoreboard's score is the last goal's
// details.homeScore/awayScore by then, and the game is 'CRIT' late in the
// third and in overtime, as the NHL marks it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeEnv, makeCtx, makeFakeCache } from './route-harness.js'

vi.mock('../seasons.js', () => ({
  resolveNHLSeason: vi.fn().mockResolvedValue(20262027),
  resolvePWHLSeason: vi.fn().mockResolvedValue({ seasonId: 8, seasonType: 'regular', startYear: 2025 }),
}))

const { sendPushMock } = vi.hoisted(() => ({ sendPushMock: vi.fn().mockResolvedValue('ok') }))
vi.mock('../shared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, sendPush: sendPushMock, sendLiveActivityPush: vi.fn().mockResolvedValue('ok') }
})

import { poll, emptyNets, goalStrengthTags, pushPeriodLabel, penaltyDescPending, summaryInputs } from '../nhl.js'
import fla_ana from './fixtures/nhl-2026020037-pbp.json'
import uta_nyr from './fixtures/nhl-2026020036-pbp.json'
import car_phi from './fixtures/nhl-2026020025-pbp.json'
import bos_ott from './fixtures/nhl-2026020041-pbp.json'
import car_vgk_2ot from './fixtures/nhl-2025030413-pbp.json'
import car_wsh_so from './fixtures/nhl-2025020485-pbp.json'

const isGoal = p => p.typeDescKey === 'goal' && p.periodDescriptor.periodType !== 'SO'
const indexOf = (fx, pred) => fx.plays.findIndex(pred)

// The game and its feed as they stood after play `upto`.
function tickAt(fx, upto, { plays: override } = {}) {
  const plays = override || fx.plays.slice(0, upto + 1)
  const last = plays[plays.length - 1]
  const goals = plays.filter(isGoal)
  const lastGoal = goals[goals.length - 1]
  const pd = last.periodDescriptor
  const late = pd.number >= 4 || (pd.number === 3 && last.timeInPeriod >= '15:00')
  const game = {
    id: fx.id, gameType: fx.gameType, gameDate: fx.gameDate, gameState: late ? 'CRIT' : 'LIVE',
    homeTeam: { ...fx.homeTeam, score: lastGoal?.details.homeScore ?? 0 },
    awayTeam: { ...fx.awayTeam, score: lastGoal?.details.awayScore ?? 0 },
    periodDescriptor: pd,
  }
  const pbp = { id: fx.id, gameType: fx.gameType, periodDescriptor: pd, rosterSpots: fx.rosterSpots, plays }
  return { game, pbp }
}

function finalOf(fx) {
  return {
    game: {
      id: fx.id, gameType: fx.gameType, gameDate: fx.gameDate, gameState: 'OFF',
      homeTeam: fx.homeTeam, awayTeam: fx.awayTeam,
      periodDescriptor: fx.periodDescriptor, gameOutcome: fx.gameOutcome,
    },
    pbp: { id: fx.id, gameType: fx.gameType, periodDescriptor: fx.periodDescriptor, rosterSpots: fx.rosterSpots, plays: fx.plays },
  }
}

function mockFeed({ live = [], completed = [] }) {
  const pbps = new Map([...live, ...completed].map(t => [String(t.game.id), t.pbp]))
  globalThis.fetch = vi.fn().mockImplementation((url) => {
    const u = String(url)
    if (u.includes('/score/now')) {
      return Promise.resolve({ ok: true, json: async () => ({ games: [...live, ...completed].map(t => t.game) }) })
    }
    if (u.includes('/play-by-play')) {
      const gid = u.match(/gamecenter\/(\d+)\//)?.[1]
      return Promise.resolve({ ok: true, json: async () => pbps.get(gid) || { plays: [] } })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const sub = abbr => ({ endpoint: `https://push.example/${abbr}`, keys: { p256dh: 'x', auth: 'y' }, teamAbbr: `NHL:${abbr}` })

function envFor(fx) {
  return makeEnv({
    VAPID_PRIVATE_KEY: 'fake-key-for-test',
    // news:CAR set so poll() doesn't go fetch the news feeds.
    CACHE: makeFakeCache({ 'push:subs': [sub(fx.homeTeam.abbrev), sub(fx.awayTeam.abbrev)], 'news:CAR': [] }),
  })
}

// Every push sent during fn(), as "<team> <title> | <body>".
async function pushesDuring(fn) {
  sendPushMock.mockClear()
  await fn()
  return sendPushMock.mock.calls.map(([s, p]) => `${s.endpoint.split('/').pop()} ${p.title} | ${p.body}`)
}

// Replays a game: a poll every `step` plays up to `lastLive`, then the
// final scoreboard (when `final`).
async function replay(fx, { lastLive, step = 3, final = true, env = envFor(fx) }) {
  return pushesDuring(async () => {
    for (let i = 0; i <= lastLive; i += step) {
      mockFeed({ live: [tickAt(fx, i)] })
      await poll(env, makeCtx())
    }
    if (lastLive % step) {
      mockFeed({ live: [tickAt(fx, lastLive)] })
      await poll(env, makeCtx())
    }
    if (final) {
      mockFeed({ completed: [finalOf(fx)] })
      await poll(env, makeCtx())
    }
  })
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const nonPenalty = pushes => pushes.filter(p => !p.includes('Power Play!'))

describe('NHL alerts replayed: FLA @ ANA, 2026-10-04 (2026020037, ANA 3-2 in OT)', () => {
  it('names every scorer, tags power-play goals, and pushes OT starting and the OT winner', async () => {
    const otGoal = indexOf(fla_ana, p => isGoal(p) && p.periodDescriptor.number === 4)
    const pushes = await replay(fla_ana, { lastLive: otGoal - 1 })
    expect(nonPenalty(pushes)).toEqual([
      'ANA 🏒 Game Starting! | ANA vs FLA — puck drop!',
      'FLA 🏒 Game Starting! | FLA vs ANA — puck drop!',
      // #1: the scorer by name (rosterSpots), never "ANA scores!".
      // #29: home goals on 1451 are power-play goals, not short-handed.
      'ANA 🚨 GOAL! ANA 1–0 FLA | Cutter Gauthier scores! (PP, snap)',
      'FLA ANA scores. FLA 0–1 ANA | ANA takes the lead. Time to push back!',
      'FLA 🚨 GOAL! FLA 1–1 ANA | Carter Verhaeghe scores! (tip-in)',
      'ANA FLA scores. ANA 1–1 FLA | FLA ties it up — stay sharp!',
      'ANA 🔔 End of P1 | ANA 1–1 FLA after P1',
      'FLA 🔔 End of P1 | FLA 1–1 ANA after P1',
      'ANA 🏒 P2 Starting | ANA 1–1 FLA — P2 underway',
      'FLA 🏒 P2 Starting | FLA 1–1 ANA — P2 underway',
      'ANA 🚨 GOAL! ANA 2–1 FLA | Cutter Gauthier scores! (PP, snap)',
      'FLA ANA scores. FLA 1–2 ANA | ANA takes the lead. Time to push back!',
      'ANA 🔔 End of P2 | ANA 2–1 FLA after P2',
      'FLA 🔔 End of P2 | FLA 1–2 ANA after P2',
      'ANA 🏒 P3 Starting | ANA 2–1 FLA — P3 underway',
      'FLA 🏒 P3 Starting | FLA 1–2 ANA — P3 underway',
      // 6-on-5 with FLA's net empty: even strength, no tag.
      'FLA 🚨 GOAL! FLA 2–2 ANA | Brad Marchand scores! (wrist)',
      'ANA FLA scores. ANA 2–2 FLA | FLA ties it up — stay sharp!',
      'ANA 🔔 End of P3 | ANA 2–2 FLA after P3',
      'FLA 🔔 End of P3 | FLA 2–2 ANA after P3',
      // #10: OT runs as 'CRIT'.
      'ANA 🏒 OT Starting | ANA 2–2 FLA — OT underway',
      'FLA 🏒 OT Starting | FLA 2–2 ANA — OT underway',
      // #10: the winner, which ended the game before a live poll saw it --
      // ahead of the result. 1341: ANA 4-on-3 after Forsling's tripping.
      'ANA 🚨 GOAL! ANA 3–2 FLA | Mikael Granlund scores! (PP, tip-in)',
      'FLA ANA scores. FLA 2–3 ANA | ANA takes the lead. Time to push back!',
      'ANA 🏆 ANA Win! ANA 3–2 FLA (OT) | Let\'s go Ducks! 🦆',
      'FLA Final/OT: FLA 2–3 ANA | Tough one. Next game.',
    ])
    // Every power play, with the real infraction.
    expect(pushes.filter(p => p.includes('Power Play!'))).toEqual([
      'ANA ⚡ ANA Power Play! | FLA — Carter Verhaeghe · Holding · 2 min',
      'FLA ⚡ FLA Power Play! | ANA — Travis Mitchell · Cross-checking · 2 min',
      'ANA ⚡ ANA Power Play! | FLA — Bench minor · Too many men on the ice · 2 min · served by Matthew Tkachuk',
      'ANA ⚡ ANA Power Play! | FLA — Lars Eller · Cross-checking · 2 min',
      'FLA ⚡ FLA Power Play! | ANA — A.J. Greer · Roughing · 2 min',
      'FLA ⚡ FLA Power Play! | ANA — Noah Warren · Holding · 2 min',
      'FLA ⚡ FLA Power Play! | ANA — A.J. Greer · Tripping · 2 min',
      'ANA ⚡ ANA Power Play! | FLA — Gustav Forsling · Tripping · 2 min',
    ])
  })

  it('sends no further goal push once the game is over and announced', async () => {
    const env = envFor(fla_ana)
    await replay(fla_ana, { lastLive: indexOf(fla_ana, p => isGoal(p) && p.periodDescriptor.number === 4) - 1, env })
    const again = await pushesDuring(async () => {
      mockFeed({ completed: [finalOf(fla_ana)] })
      await poll(env, makeCtx())
    })
    expect(again).toEqual([])
  })

  // #1: /score/now can be a poll ahead of the play-by-play. FLA's tying goal
  // (P3 18:10) went out as "FLA scores!" with no shot type: the feed's last
  // FLA goal then was the earlier one.
  it('waits a poll for a goal whose play has not posted, then names its scorer', async () => {
    const env = envFor(fla_ana)
    const tying = indexOf(fla_ana, p => isGoal(p) && p.timeInPeriod === '18:10')
    await replay(fla_ana, { lastLive: tying - 3, final: false, env })
    const lagging = tickAt(fla_ana, tying - 1)
    lagging.game.awayTeam.score = 2 // the scoreboard already has it
    const first = await pushesDuring(async () => {
      mockFeed({ live: [lagging] })
      await poll(env, makeCtx())
    })
    expect(first.filter(p => /GOAL|scores\./.test(p))).toEqual([])

    const caughtUp = await pushesDuring(async () => {
      mockFeed({ live: [tickAt(fla_ana, tying + 1)] })
      await poll(env, makeCtx())
    })
    expect(caughtUp.filter(p => /GOAL|scores\./.test(p))).toEqual([
      'FLA 🚨 GOAL! FLA 2–2 ANA | Brad Marchand scores! (wrist)',
      'ANA FLA scores. ANA 2–2 FLA | FLA ties it up — stay sharp!',
    ])
  })

  it('sends the goal without a name if its play still has not posted a poll later', async () => {
    const env = envFor(fla_ana)
    const tying = indexOf(fla_ana, p => isGoal(p) && p.timeInPeriod === '18:10')
    await replay(fla_ana, { lastLive: tying - 3, final: false, env })
    const lagging = tickAt(fla_ana, tying - 1)
    lagging.game.awayTeam.score = 2
    const pushes = await pushesDuring(async () => {
      for (let i = 0; i < 2; i++) {
        mockFeed({ live: [lagging] })
        await poll(env, makeCtx())
      }
    })
    expect(pushes.filter(p => /GOAL/.test(p))).toEqual(['FLA 🚨 GOAL! FLA 2–2 ANA | FLA scores!'])
  })
})

describe('NHL alerts replayed: UTA @ NYR, 2026-10-04 (2026020036)', () => {
  // #9: the feed has no 'goalie-pulled' play. UTA's pull shows only as
  // situationCode 0651 from P3 18:18; NYR's P2 04:28 delayed-penalty pull
  // (1560) isn't one.
  it('pushes UTA pulling its goalie to NYR fans, once, and tags the empty-net goal', async () => {
    const last = indexOf(uta_nyr, p => p.typeDescKey === 'game-end')
    const pushes = await replay(uta_nyr, { lastLive: last, step: 1 })
    expect(pushes.filter(p => /pulled/.test(p))).toEqual([
      'NYR 🥅 UTA pulled their goalie! | 6-on-5 — NYR 3–2. Empty net opportunity!',
    ])
    expect(pushes.filter(p => p.startsWith('NYR 🚨 GOAL!'))).toContain(
      'NYR 🚨 GOAL! NYR 4–2 UTA | Eeli Tolvanen scores! (EN, wrist)')
  })
})

describe('NHL alerts replayed: CAR @ VGK, 2026-06-06 playoffs, round 4 game 3 (2025030413, VGK 5-4 in 2OT)', () => {
  // #30: playoff overtimes are OT, 2OT... -- 'SO' and 'P6' before.
  // #1: the hat trick names Marner, counted from his own goal plays.
  it('labels the overtimes, names the hat trick, and pushes the 2OT winner', async () => {
    const winner = car_vgk_2ot.plays.findLastIndex(isGoal)
    const pushes = await replay(car_vgk_2ot, { lastLive: winner - 1, step: 1 })
    expect(pushes.filter(p => /HAT TRICK|OT|Win!|5–4/.test(p))).toEqual([
      'VGK 🎩 HAT TRICK! Mitch Marner | Mitch Marner scores their 3rd goal of the game!',
      'VGK 🏒 OT Starting | VGK 4–4 CAR — OT underway',
      'CAR 🏒 OT Starting | CAR 4–4 VGK — OT underway',
      'VGK 🔔 End of OT | VGK 4–4 CAR after OT',
      'CAR 🔔 End of OT | CAR 4–4 VGK after OT',
      'VGK 🏒 2OT Starting | VGK 4–4 CAR — 2OT underway',
      'CAR 🏒 2OT Starting | CAR 4–4 VGK — 2OT underway',
      'VGK 🚨 GOAL! VGK 5–4 CAR | Shea Theodore scores! (slap)',
      'VGK 🏆 VGK Win! VGK 5–4 CAR (OT) | Let\'s go Knights! ⚔️',
      'CAR Final/OT: CAR 4–5 VGK | Tough one. Next game.',
    ])
    // CAR's 6-on-4 tying goal (0641): a power play with the extra attacker.
    expect(pushes).toContain('CAR 🚨 GOAL! CAR 4–4 VGK | Andrei Svechnikov scores! (PP, wrist)')
  })
})

describe('NHL alerts replayed: CAR @ WSH, 2025-12-11 (2025020485, CAR 3-2 SO)', () => {
  it('sends no goal push for the shootout, only the result', async () => {
    const pushes = await replay(car_wsh_so, { lastLive: car_wsh_so.plays.length - 2, step: 1 })
    expect(pushes.slice(-4)).toEqual([
      'WSH 🏒 SO Starting | WSH 2–2 CAR — SO underway',
      'CAR 🏒 SO Starting | CAR 2–2 WSH — SO underway',
      'WSH Final/SO: WSH 2–3 CAR | Tough one. Next game.',
      'CAR 🏆 CAR Win! CAR 3–2 WSH (SO) | Let\'s go Canes! 🌀',
    ])
  })
})

describe('NHL alerts replayed: CAR @ PHI, 2026-10-03 (2026020025, CAR 3-2 in OT)', () => {
  it('pushes the OT winner before the result', async () => {
    const winner = car_phi.plays.findLastIndex(isGoal)
    const pushes = await replay(car_phi, { lastLive: winner - 1, step: 2 })
    expect(pushes.slice(-4)).toEqual([
      'CAR 🚨 GOAL! CAR 3–2 PHI | Shayne Gostisbehere scores! (PP, slap)',
      'PHI CAR scores. PHI 2–3 CAR | CAR takes the lead. Time to push back!',
      'PHI Final/OT: PHI 2–3 CAR | Tough one. Next game.',
      'CAR 🏆 CAR Win! CAR 3–2 PHI (OT) | Let\'s go Canes! 🌀',
    ])
  })
})

// #11: a live penalty first posts with descKey 'minor' and gets its real
// infraction later. BOS-OTT 2026-10-04 pushed "BOS — Elias Lindholm ·
// Minor · 2 min" for what the final feed has as interference (P2 08:02).
describe('power-play pushes for a penalty posted before its infraction', () => {
  const lindholm = indexOf(bos_ott, p => p.typeDescKey === 'penalty' && p.timeInPeriod === '08:02')
  const withDesc = (upto, descKey) => {
    const plays = bos_ott.plays.slice(0, upto + 1).map((p, i) =>
      i === lindholm ? { ...p, details: { ...p.details, descKey } } : p)
    return tickAt(bos_ott, upto, { plays })
  }
  const ppPushes = async (env, ...ticks) => pushesDuring(async () => {
    for (const t of ticks) {
      mockFeed({ live: [t] })
      await poll(env, makeCtx())
    }
  }).then(pushes => pushes.filter(p => p.includes('Power Play!')))

  it('holds it a poll and sends the real infraction', async () => {
    const env = envFor(bos_ott)
    await replay(bos_ott, { lastLive: lindholm - 1, final: false, env })
    expect(await ppPushes(env, withDesc(lindholm, 'minor'))).toEqual([])
    expect(await ppPushes(env, withDesc(lindholm + 1, 'interference'))).toEqual([
      'OTT ⚡ OTT Power Play! | BOS — Elias Lindholm · Interference · 2 min',
    ])
    expect(await ppPushes(env, withDesc(lindholm + 2, 'interference'))).toEqual([])
  })

  it('leaves the placeholder word out if the infraction is still missing a poll later', async () => {
    const env = envFor(bos_ott)
    await replay(bos_ott, { lastLive: lindholm - 1, final: false, env })
    expect(await ppPushes(env, withDesc(lindholm, 'minor'))).toEqual([])
    expect(await ppPushes(env, withDesc(lindholm + 1, 'minor'))).toEqual([
      'OTT ⚡ OTT Power Play! | BOS — Elias Lindholm · 2 min',
    ])
  })

  it('treats only a missing or class-only descKey as pending', () => {
    expect(penaltyDescPending({ descKey: 'minor' })).toBe(true)
    expect(penaltyDescPending({ descKey: 'major' })).toBe(true)
    expect(penaltyDescPending({})).toBe(true)
    expect(penaltyDescPending({ descKey: 'interference' })).toBe(false)
    expect(penaltyDescPending({ descKey: 'bench' })).toBe(false)
  })
})

describe('goalStrengthTags()', () => {
  // Codes from goals on 2026-10-04 and in 2025030413, [awayG][awayS][homeS][homeG].
  it('reads the scoring side, not a fixed digit (#29)', () => {
    expect(goalStrengthTags('1451', true)).toEqual(['PP'])   // ANA Gauthier, home PP
    expect(goalStrengthTags('1451', false)).toEqual(['SH'])
    expect(goalStrengthTags('1541', true)).toEqual(['SH'])   // home short-handed
    expect(goalStrengthTags('1551', true)).toEqual([])
    expect(goalStrengthTags('0651', false)).toEqual([])      // FLA Marchand, extra attacker
    expect(goalStrengthTags('0651', true)).toEqual(['EN'])   // NYR Tolvanen
    expect(goalStrengthTags('0641', false)).toEqual(['PP'])  // CAR Svechnikov, 6-on-4
    expect(goalStrengthTags('1341', true)).toEqual(['PP'])   // ANA Granlund, OT 4-on-3
    expect(goalStrengthTags('1020', true)).toEqual([])       // impossible code
    expect(goalStrengthTags(undefined, true)).toEqual([])
  })
})

describe('pushPeriodLabel()', () => {
  it('names playoff overtimes and the shootout (#30)', () => {
    expect(pushPeriodLabel(2, 'REG', 2)).toBe('P2')
    expect(pushPeriodLabel(4, 'OT', 2)).toBe('OT')
    expect(pushPeriodLabel(5, 'SO', 2)).toBe('SO')
    expect(pushPeriodLabel(5, undefined, 2)).toBe('SO')
    expect(pushPeriodLabel(4, 'OT', 3)).toBe('OT')
    expect(pushPeriodLabel(5, 'OT', 3)).toBe('2OT')
    expect(pushPeriodLabel(6, undefined, 3)).toBe('3OT')
  })
})

describe('emptyNets()', () => {
  it('finds a pull from the situationCode, skipping delayed penalties (#9)', () => {
    const at = (fx, pred) => fx.plays.slice(0, indexOf(fx, pred) + 1)
    // FLA-ANA P1 09:12: the penalty that ended a delayed penalty, coded 0651.
    expect(emptyNets(at(fla_ana, p => p.typeDescKey === 'penalty' && p.timeInPeriod === '09:12')))
      .toEqual({ away: null, home: null })
    // UTA-NYR P2 04:28: NYR's delayed-penalty pull, 1560.
    expect(emptyNets(at(uta_nyr, p => p.typeDescKey === 'penalty' && p.timeInPeriod === '04:28')))
      .toEqual({ away: null, home: null })
    // UTA's pull at P3 18:18, still on at 18:41.
    const pull = emptyNets(at(uta_nyr, p => p.typeDescKey === 'blocked-shot' && p.timeInPeriod === '18:41'))
    expect(pull.home).toBeNull()
    expect(pull.away).toMatchObject({ timeInPeriod: '18:18', situationCode: '0651' })
    // Back in for the faceoff after NYR's empty-net goal.
    expect(emptyNets(at(uta_nyr, p => p.typeDescKey === 'faceoff' && p.timeInPeriod === '18:45')).away).toBeNull()
  })
})

// #31
describe('summaryInputs()', () => {
  const won = { teamId: 12, abbr: 'CAR', oppAbbr: 'PHI', won: true, oppScore: 2, gameType: 2 }
  it('names the real top scorer and the game-winning goal separately (CAR @ PHI, 2026020025)', () => {
    const s = summaryInputs(car_phi, won)
    expect(s.topScorer).toBe('Sebastian Aho')
    expect(s.topScorerGoals).toBe(2)
    expect(s.gwgScorer).toBe('Shayne Gostisbehere')
    expect(s.goals.map(g => `${g.team} ${g.scorer} ${g.periodLabel} ${g.time}`)).toEqual([
      'CAR Sebastian Aho P1 00:10',
      'PHI Owen Tippett P1 08:03',
      'PHI Matvei Michkov P2 07:20',
      'CAR Sebastian Aho P3 04:59',
      'CAR Shayne Gostisbehere OT 02:51',
    ])
    expect(s.cfPct).toBeGreaterThan(0)
    expect(s.cfPct).toBeLessThan(100)
  })

  it('has no top scorer on a tie, and no game-winner in a shootout win (2025020485)', () => {
    const s = summaryInputs(car_wsh_so, { teamId: 12, abbr: 'CAR', oppAbbr: 'WSH', won: true, oppScore: 2, gameType: 2 })
    expect(s.goals).toHaveLength(4) // the shootout's attempts aren't goals
    expect(s.topScorer).toBeNull()
    expect(s.gwgScorer).toBeNull()
  })

  it('leaves CF% unknown, not 50%, without a play-by-play', () => {
    expect(summaryInputs(null, won)).toMatchObject({ cfPct: null, goals: [], topScorer: null, gwgScorer: null })
  })
})
