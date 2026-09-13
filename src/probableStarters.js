// Shape helper for GET /probable-starters (eyewall-pipeline's
// starting_goalie.py -> goalie_start_probs). Pure, unit-tested in
// __tests__/probableStarters.test.js.

// goalie_start_probs rows for one game (both teams) -> { gameDate, runDate,
// teams: { ABBR: [{ goalie_id, goalie_name, start_prob, factors }] } },
// each team's goalies most likely first. runDate is the newest run among
// the rows (each team's rows are rewritten nightly).
export function summarizeStarters(rows) {
  const teams = {};
  let gameDate = null;
  let runDate = null;
  for (const r of rows || []) {
    (teams[r.team] ||= []).push({
      goalie_id: r.goalie_id,
      goalie_name: r.goalie_name,
      start_prob: r.start_prob,
      factors: r.factors ?? null,
    });
    gameDate ||= r.game_date ?? null;
    if (r.run_date && (!runDate || r.run_date > runDate)) runDate = r.run_date;
  }
  for (const list of Object.values(teams)) {
    list.sort((a, b) => b.start_prob - a.start_prob || String(a.goalie_name).localeCompare(String(b.goalie_name)));
  }
  return { gameDate, runDate, teams };
}
