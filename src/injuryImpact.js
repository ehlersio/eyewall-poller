// Shape helper for GET /injury-impact (eyewall-pipeline's injury_impact.py:
// man-games and WAR each team has lost to injury -> team_injury_impact).
// Pure, unit-tested in __tests__/injuryImpact.test.js.

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

// Every team's team_injury_impact row for a season -> league averages, the
// context a single team's totals are read against.
export function summarizeInjuryLeague(rows) {
  const n = rows?.length || 0;
  if (!n) return { teams: 0, avgManGames: null, avgWarLost: null, avgGamesPlayed: null };
  const avg = key => rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / n;
  return {
    teams: n,
    avgManGames: round(avg('man_games_lost'), 1),
    avgWarLost: round(avg('war_lost'), 3),
    avgGamesPlayed: round(avg('games_played'), 1),
  };
}
