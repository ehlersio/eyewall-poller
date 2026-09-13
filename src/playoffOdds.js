// Shape helpers for GET /playoff-odds (eyewall-pipeline's playoff_odds.py:
// the rest of the NHL regular season simulated nightly from team Elo
// ratings -> playoff_odds / playoff_odds_game_impacts). Pure functions,
// unit-tested in __tests__/playoffOdds.test.js.

// Other teams' games shown besides the team's own, and the smallest swing
// in the team's odds (between the two results) worth showing.
export const NEXT_GAMES_OTHERS = 2;
export const NEXT_GAMES_MIN_SWING = 0.005;

// The nightly writes a row every day there are regular-season games left
// (All-Star/Olympic breaks included), so a latest run older than this means
// the regular season is over -- or the nightly stopped running.
export const PLAYOFF_ODDS_STALE_DAYS = 3;

// playoff_odds_game_impacts rows for one team and one run -> one entry per
// game: the team's playoff odds if the home team wins vs if the away team
// wins. The team's own games first, then the other games whose result moves
// its odds the most (at least NEXT_GAMES_MIN_SWING, at most
// NEXT_GAMES_OTHERS). A game missing either outcome is dropped.
export function summarizeNextGames(rows, team) {
  const games = new Map();
  for (const r of rows || []) {
    const g = games.get(r.game_id) || {
      game_id: r.game_id, game_date: r.game_date, home: r.home_team, away: r.away_team,
      ifHomeWins: null, ifAwayWins: null,
    };
    if (r.outcome === 'home') g.ifHomeWins = r.playoff_pct;
    else if (r.outcome === 'away') g.ifAwayWins = r.playoff_pct;
    games.set(r.game_id, g);
  }
  const complete = [...games.values()]
    .filter(g => g.ifHomeWins != null && g.ifAwayWins != null)
    .map(g => ({ ...g, own: g.home === team || g.away === team, swing: Math.abs(g.ifHomeWins - g.ifAwayWins) }));
  const own = complete.filter(g => g.own).sort((a, b) => a.game_id - b.game_id);
  const others = complete
    .filter(g => !g.own && g.swing >= NEXT_GAMES_MIN_SWING)
    .sort((a, b) => b.swing - a.swing)
    .slice(0, NEXT_GAMES_OTHERS);
  return [...own, ...others];
}

// run_date is the pipeline's America/New_York date; noon UTC keeps the age
// from flipping on time zones.
export function isPlayoffOddsStale(runDate, now = Date.now()) {
  const age = (now - Date.parse(`${runDate}T12:00:00Z`)) / 86400000;
  return age > PLAYOFF_ODDS_STALE_DAYS;
}
