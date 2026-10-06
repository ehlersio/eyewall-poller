/**
 * hockeytechGame.js — EyeWall Analytics Worker
 *
 * Per-game helpers shared by every HockeyTech league (PWHL in pwhl.js,
 * AHL/ECHL in hockeytech.js): who played in a game, by name, and whether a
 * goalie_change is a real late-game pull.
 */

// { [playerId]: { name, teamId, jerseyNumber } } for everyone who dressed,
// from HockeyTech's view=gameSummary (homeTeam/visitingTeam skaters[] and
// goalies[], each { info: { id, firstName, lastName, jerseyNumber } }).
//
// This is the game's own lineup, so it names a player who has since
// changed teams -- {league}_players only knows each player's team today,
// which is why box scores and PBP rows used to come back unnamed for them.
// A player the summary doesn't list is left out, never guessed.
export function gameSummaryPlayers(summary) {
  const players = {};
  for (const side of ['homeTeam', 'visitingTeam']) {
    const team = summary?.[side];
    const teamId = parseInt(team?.info?.id, 10) || null;
    for (const p of [...(team?.skaters || []), ...(team?.goalies || [])]) {
      const info = p?.info || {};
      const id = parseInt(info.id, 10);
      if (!id) continue;
      const name = `${info.firstName || ''} ${info.lastName || ''}`.trim();
      if (!name) continue;
      players[id] = { name, teamId, jerseyNumber: info.jerseyNumber ?? null };
    }
  }
  return players;
}

// Fetches and parses one game's view=gameSummary, or null when HockeyTech
// is unreachable or returns something unparseable -- callers then fall
// back to {league}_players for names.
export async function fetchGameSummary(url, headers) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    let text = (await res.text()).trim();
    if (text.startsWith('(')) text = text.slice(1, text.lastIndexOf(')'));
    const summary = JSON.parse(text);
    return summary && typeof summary === 'object' ? summary : null;
  } catch {
    return null;
  }
}

// ── Goalie pulls ─────────────────────────────────────────────────────
// HockeyTech logs every trip to the bench as a goalie_change with
// goalieComingIn: null -- including the few seconds a goalie spends off
// for a delayed penalty, any time in any period. The goaliePulled alert
// ("6-on-5 -- empty net opportunity") only means something for a pull for
// an extra attacker, which is a trailing team late in regulation. Real
// play-by-play checked 2026-10-05: in 111 AHL games (2025-26 finale weeks
// and the 2026-27 opening weekend) and 90 PWHL games (2025-26 ids
// 240-329), every extra-attacker pull was in the 3rd period by a trailing
// team, the earliest at 10:46 (PWHL, down 2); delayed-penalty pulls came
// in every period, tied or not, and mostly lasted under 30 seconds.
const PULL_WINDOW_START_SECONDS = 10 * 60; // last 10 minutes of the 3rd
const PERIOD_SECONDS = 20 * 60;

function clockSeconds(t) {
  const m = /^(\d+):(\d{1,2})$/.exec(String(t || '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

// True when events[index] is a goalie leaving for an extra attacker:
//   - in the 3rd period, with 10 minutes or less to play (HockeyTech's
//     time is elapsed time, so 10:00-19:59), not the 20:00 period-end
//     entry;
//   - by a team trailing at that moment (goal events before it);
//   - and not already back: no later goalie_change in the same feed puts
//     a goalie back in for that team (a delayed-penalty pull usually ends
//     before the next poll, so the return is already in the feed).
// Overtime is excluded by the trailing rule -- nobody trails in OT.
export function isExtraAttackerPull(events, index) {
  const ev = events[index];
  const d = ev?.details || {};
  if (ev?.event !== 'goalie_change' || d.goalieComingIn !== null || !d.goalieGoingOut) return false;

  if (String(d.period?.id ?? '').trim() !== '3') return false;
  const elapsed = clockSeconds(d.time);
  if (elapsed == null || elapsed < PULL_WINDOW_START_SECONDS || elapsed >= PERIOD_SECONDS) return false;

  const teamId = parseInt(d.team_id, 10);
  if (!teamId) return false;
  let mine = 0, theirs = 0;
  for (let i = 0; i < index; i++) {
    if (events[i]?.event !== 'goal') continue;
    const scorer = parseInt(events[i].details?.team?.id, 10);
    if (scorer === teamId) mine++;
    else if (scorer) theirs++;
  }
  if (mine >= theirs) return false;

  for (let i = index + 1; i < events.length; i++) {
    const later = events[i];
    if (later?.event === 'goalie_change'
        && parseInt(later.details?.team_id, 10) === teamId
        && later.details?.goalieComingIn) return false;
  }
  return true;
}

// A HockeyTech period id as a number. Most events carry "1".."5" (a
// playoff second overtime is "5", shortName "OT2" -- PWHL 344), but some
// carry "OT1" (blocked shots in PWHL 227's overtime); the shootout, whose
// events have no period, is put in 7 by the routes that list it.
export function hockeytechPeriodNumber(raw) {
  const periodMap = { 'OT1': 4, 'OT2': 5, 'OT3': 6, 'SO': 7 };
  const s = String(raw ?? '1');
  return periodMap[s] ?? (parseInt(s, 10) || 1);
}

// A HockeyTech period's name, as the NHL alerts name theirs (see nhl.js's
// pushPeriodLabel): P1-P3, OT, then 2OT/3OT, and SO. Takes the period
// number of hockeytechPeriodNumber() -- OT1 4, OT2 5, OT3 6, SO 7 -- so a
// second overtime (only played in the playoffs) and the shootout never
// share a number, and no game type is needed to tell them apart. Null for
// anything else; never a raw "P4".
export function hockeytechPeriodLabel(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) return null;
  if (num <= 3) return `P${num}`;
  if (num === 4) return 'OT';
  if (num === 7) return 'SO';
  return `${num - 3}OT`;
}
