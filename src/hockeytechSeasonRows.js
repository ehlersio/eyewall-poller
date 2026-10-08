/**
 * hockeytechSeasonRows.js — EyeWall Analytics Worker
 *
 * One AHL/ECHL player-season from {league}_player_seasons /
 * {league}_goalie_seasons, whichever way the pipeline stores it:
 *   - old shape: one league-wide row per player per season (team_id = his
 *     last team);
 *   - new shape (eyewall-pipeline#190, audit #14): one row per team he
 *     played for that season.
 * League-wide routes (/league-players, /player/landing) combine a player's
 * rows into one: counting stats summed, rates recomputed from the sums.
 * Team-scoped routes (/players) keep the team's own row.
 */

const SKATER_SUMS = ['gp', 'goals', 'assists', 'points', 'shots', 'pp_goals', 'sh_goals', 'pim', 'plus_minus'];
const GOALIE_SUMS = ['gp', 'wins', 'losses', 'ot_losses', 'shutouts', 'saves', 'goals_against', 'shots_against'];

// A goalie row's time on ice -> seconds, or null when the column is
// missing/unparseable. The pipeline stores HockeyTech's own text, which
// comes two ways: "1648:49" (minutes:seconds, the league-wide rows) and
// "1294" (whole minutes, view=players' minutes_played on the per-team rows
// of eyewall-pipeline#190 -- every traded goalie's rows in 2025-26).
function toiSeconds(toi) {
  if (typeof toi === 'number') return Number.isFinite(toi) && toi >= 0 ? Math.round(toi * 60) : null;
  const s = String(toi ?? '').trim();
  const mmss = /^(\d+):(\d{1,2})$/.exec(s);
  if (mmss) return parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10);
  return /^\d+(\.\d+)?$/.test(s) ? Math.round(parseFloat(s) * 60) : null;
}

// Summed seconds back as text, in the rows' own form: whole minutes when
// every row was whole minutes, otherwise minutes:seconds.
function formatToi(seconds, rows) {
  const minutesOnly = rows.every(r => typeof r.toi === 'number' || /^\d+(\.\d+)?$/.test(String(r.toi ?? '').trim()));
  if (minutesOnly) return String(Math.round(seconds / 60));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Sum of `field` over rows, or null when no row has it (never 0 for
// "unknown").
function sumField(rows, field) {
  const vals = rows.map(r => r[field]).filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

// The team a combined row is shown under: the player's current team when
// he played for it that season, otherwise the team he played the most
// games for.
function displayTeam(rows, currentTeamId) {
  if (currentTeamId != null && rows.some(r => r.team_id === currentTeamId)) return currentTeamId;
  return [...rows].sort((a, b) => (b.gp ?? 0) - (a.gp ?? 0))[0]?.team_id ?? null;
}

/**
 * One player's season rows -> one row. A single row comes back as is.
 * Several: SKATER_SUMS / GOALIE_SUMS summed; a goalie's sv_pct (saves /
 * shots against, 3 dp) and gaa (goals against per 60 of TOI, 2 dp) are
 * recomputed from the sums -- null when a row lacks what's needed -- and
 * toi is the summed time. `teams` keeps every per-team row. Before
 * 2026-10-08 a whole-minutes toi ("1294") didn't parse, so every traded
 * goalie (Brossoit, Shepard 2025-26) came back with gaa null.
 *
 * @param {object[]} rows   the player's rows for one season
 * @param {'skater'|'goalie'} kind
 * @param {number|null} currentTeamId  {league}_players.team_id
 */
export function combineSeasonRows(rows, kind, currentTeamId = null) {
  if (rows.length <= 1) return rows[0] ?? null;
  const out = { ...rows[0] };
  delete out.id;
  delete out.updated_at;
  for (const f of kind === 'goalie' ? GOALIE_SUMS : SKATER_SUMS) out[f] = sumField(rows, f);
  out.team_id = displayTeam(rows, currentTeamId);
  out.teams = rows.map(r => ({ ...r }));

  if (kind === 'goalie') {
    const shots = out.shots_against ?? (out.saves != null && out.goals_against != null ? out.saves + out.goals_against : null);
    out.sv_pct = shots ? round(out.saves / shots, 3) : null;
    const secs = rows.map(r => toiSeconds(r.toi));
    const total = secs.every(s => s != null) ? secs.reduce((a, b) => a + b, 0) : null;
    out.toi = total != null ? formatToi(total, rows) : null;
    out.gaa = total && out.goals_against != null ? round(out.goals_against * 3600 / total, 2) : null;
  }
  return out;
}

/**
 * Every player's rows (any mix of old and new shapes) -> one combined row
 * per player, in first-seen order.
 * @param {object} currentTeams  { [playerId]: team_id } from {league}_players
 */
export function combineByPlayer(rows, kind, currentTeams = {}) {
  const byPlayer = new Map();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  return [...byPlayer.entries()].map(([id, list]) => combineSeasonRows(list, kind, currentTeams[id] ?? null));
}
