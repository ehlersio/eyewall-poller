// penaltyText.js
// Readable text for an NHL play-by-play penalty: who it's against, who
// serves it, and what it was for. Ported from eyewall-analytics'
// src/utils/penaltyText.js (app PR #444) so pushes and the Lock Screen
// read the same as the app.
//
// A bench penalty (too many men, a failed coach's challenge) names no
// player: its committedByPlayerId is absent and the play carries
// servedByPlayerId instead, the skater who sits in the box. The Live
// Activity used to fall back to that server as the offender -- BOS-CAR
// 2026-04-07 (game 2025021237, P1 17:25) read "PEN · CAR · Hall · 2 min
// delaying game unsuccessful challenge" for a coach's challenge. A player's
// own penalty can carry servedByPlayerId too: a goalie's minor is served by
// a skater.
//
// English only: pushes and Live Activity updates carry no locale (a
// subscription has none; an activity's state is one per game).

// eyewall-analytics' en.json penalties.desc.*. KEEP IN SYNC with it.
export const PENALTY_DESC = {
  'abuse-of-officials': 'Abuse of officials',
  'abusive-language': 'Abusive language',
  'bench': 'Bench minor',
  'boarding': 'Boarding',
  'broken-stick': 'Broken stick',
  'butt-ending': 'Butt-ending',
  'charging': 'Charging',
  'closing-hand-on-puck': 'Closing hand on puck',
  'cross-checking': 'Cross-checking',
  'delaying-game': 'Delay of game',
  'delaying-game-bench': 'Delay of game (bench)',
  'delaying-game-face-off-violation': 'Delay of game (faceoff violation)',
  'delaying-game-puck-over-glass': 'Delay of game (puck over glass)',
  'delaying-game-unsuccessful-challenge': 'Delay of game (unsuccessful challenge)',
  'elbowing': 'Elbowing',
  'embellishment': 'Embellishment',
  'fighting': 'Fighting',
  'game-misconduct': 'Game misconduct',
  'goalie-leave-crease': 'Goalie leaving the crease',
  'head-butting': 'Head-butting',
  'high-sticking': 'High-sticking',
  'high-sticking-double-minor': 'High-sticking (double minor)',
  'holding': 'Holding',
  'holding-the-stick': 'Holding the stick',
  'hooking': 'Hooking',
  'illegal-check-to-head': 'Illegal check to the head',
  'instigator': 'Instigator',
  'instigator-misconduct': 'Instigator misconduct',
  'interference': 'Interference',
  'interference-goalkeeper': 'Goaltender interference',
  'kneeing': 'Kneeing',
  'match-penalty': 'Match penalty',
  'misconduct': 'Misconduct',
  'playing-without-a-helmet': 'Playing without a helmet',
  'ps-hooking-on-breakaway': 'Penalty shot (hooking on a breakaway)',
  'ps-slash-on-breakaway': 'Penalty shot (slashing on a breakaway)',
  'ps-throwing-object-at-puck': 'Penalty shot (object thrown at the puck)',
  'ps-tripping-on-breakaway': 'Penalty shot (tripping on a breakaway)',
  'roughing': 'Roughing',
  'roughing-removing-opponents-helmet': "Roughing (removing an opponent's helmet)",
  'slashing': 'Slashing',
  'spearing': 'Spearing',
  'throwing-equipment': 'Throwing equipment',
  'too-many-men-on-the-ice': 'Too many men on the ice',
  'tripping': 'Tripping',
  'unsportsmanlike-conduct': 'Unsportsmanlike conduct',
  'unsportsmanlike-conduct-bench': 'Unsportsmanlike conduct (bench)',
};

// A play's descKey ("delaying-game-unsuccessful-challenge") as a reader
// would say it ("Delay of game (unsuccessful challenge)"). A key the NHL
// adds later reads as its own words, hyphens to spaces, first letter
// capped. Null when there's no descKey.
export function penaltyDescription(descKey) {
  if (!descKey || typeof descKey !== 'string') return null;
  if (Object.hasOwn(PENALTY_DESC, descKey)) return PENALTY_DESC[descKey];
  const words = descKey.replace(/-/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

// Who a penalty is against, from the play's details. `nameOf(id)` returns
// a name or null/''; a name the roster doesn't have stays null, never a
// guess -- and never the server's, standing in for the offender.
export function penaltyParties(details, nameOf) {
  const d = details || {};
  const committedId = d.committedByPlayerId ?? null;
  const servedId    = d.servedByPlayerId ?? null;
  return {
    committedName: committedId != null ? (nameOf(committedId) || null) : null,
    servedByName:  servedId != null && servedId !== committedId ? (nameOf(servedId) || null) : null,
    // No player committed it: a bench or team penalty. Unlike the app,
    // only when the play says so (a bench typeCode, or someone serving
    // it): a live play can post before its details are filled in, and a
    // player's minor missing its player isn't the team's.
    teamPenalty:   committedId == null && (d.typeCode === 'BEN' || servedId != null),
    benchMinor:    d.typeCode === 'BEN' && (d.duration == null || d.duration === 2),
  };
}

// The parts of a penalty's text, in reading order, empty ones dropped:
// who it's against (the player, "Bench minor" or "Team penalty"; left out
// when a player committed it but the roster has no name for them), what
// for, how long, and who serves it.
//   Bench minor · Delay of game (unsuccessful challenge) · 2 min · served by Taylor Hall
export function penaltyParts(details, nameOf) {
  const d = details || {};
  const parties = penaltyParties(d, nameOf);
  const who = parties.committedName
    || (parties.benchMinor ? 'Bench minor' : parties.teamPenalty ? 'Team penalty' : null);
  const desc = penaltyDescription(d.descKey);
  return [
    who,
    desc && desc !== who ? desc : null, // descKey 'bench' reads "Bench minor" too
    d.duration ? `${d.duration} min` : null,
    parties.servedByName ? `served by ${parties.servedByName}` : null,
  ].filter(Boolean);
}

export function penaltyText(details, nameOf) {
  return penaltyParts(details, nameOf).join(' · ');
}
