// src/scratches.js
// Pure helpers for GET /scratches (nhl.js), which summarizes one team's
// season from eyewall-pipeline's game_scratches table (scratches.py -- the
// NHL's own right-rail scratch lists, one row per scratched player per
// game). No imports, so the Vitest suite can test the summary directly.
//
// Each row's scratch_type was set by scratches.py's classify() against that
// day's player_injury_history snapshot: 'healthy' (not on the injury
// report), 'injured', 'suspended', or 'unknown' (no snapshot close enough
// to judge -- every game before 2026-09-12). `classified` tells a consumer
// whether a healthy/injured split means anything yet for this season.

export const SCRATCH_TYPES = ['healthy', 'injured', 'suspended', 'unknown'];

// game_scratches rows -> { players, totals, games_with_scratches, classified }.
// players: one entry per player_id, most-scratched first (ties: more
// healthy scratches, then most recent, then name).
export function summarizeScratches(rows) {
  const players = new Map();
  const totals = { healthy: 0, injured: 0, suspended: 0, unknown: 0 };
  const games = new Set();

  for (const row of rows || []) {
    if (row.player_id == null) continue;
    const type = SCRATCH_TYPES.includes(row.scratch_type) ? row.scratch_type : 'unknown';
    let player = players.get(row.player_id);
    if (!player) {
      player = {
        player_id: row.player_id, player_name: row.player_name || null,
        total: 0, healthy: 0, injured: 0, suspended: 0, unknown: 0, last_date: null,
      };
      players.set(row.player_id, player);
    }
    player.total += 1;
    player[type] += 1;
    totals[type] += 1;
    if (row.player_name) player.player_name = row.player_name;
    if (row.game_date && (!player.last_date || row.game_date > player.last_date)) player.last_date = row.game_date;
    if (row.game_id != null) games.add(row.game_id);
  }

  const list = [...players.values()].sort((a, b) =>
    b.total - a.total
    || b.healthy - a.healthy
    || (b.last_date || '').localeCompare(a.last_date || '')
    || (a.player_name || '').localeCompare(b.player_name || ''));

  return {
    players: list,
    totals,
    games_with_scratches: games.size,
    classified: totals.healthy + totals.injured + totals.suspended > 0,
  };
}
