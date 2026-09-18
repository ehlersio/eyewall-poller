// Shape helper for GET /projected-lines (eyewall-pipeline's
// projected_lines.py -> projected_lines). Pure, unit-tested in
// __tests__/projectedLines.test.js.

// Left wing, center, right wing for forwards, the way lines are written.
const FWD_ORDER = { L: 0, LW: 0, C: 1, R: 2, RW: 2 };

// projected_lines rows for one team -> { basis, basisGameId, basisGames,
// generatedAt, lines, pairs }. lines/pairs are ranked units of
// { rank, players: [{ id, name, pos, filled }] }; `filled` marks a player who
// wasn't in the lineup the projection is based on (an injury / roster-move
// replacement -- the least certain part). Every row of a team is written in
// the same run, so basis/generatedAt are read off the first row. No rows ->
// basis null and empty lists (the UI hides the section).
export function summarizeProjectedLines(rows) {
  const list = rows || [];
  const first = list[0];
  const lines = [];
  const pairs = [];
  for (const r of list) {
    const filled = new Set(r.filled_ids || []);
    const players = (r.player_ids || []).map((id, i) => ({
      id,
      name: r.names?.[i] ?? String(id),
      pos: r.positions?.[i] ?? null,
      filled: filled.has(id),
    }));
    if (r.unit_type === 'F') {
      players.sort((a, b) => (FWD_ORDER[a.pos] ?? 1) - (FWD_ORDER[b.pos] ?? 1));
      lines.push({ rank: r.rank, players });
    } else {
      pairs.push({ rank: r.rank, players });
    }
  }
  lines.sort((a, b) => a.rank - b.rank);
  pairs.sort((a, b) => a.rank - b.rank);
  return {
    basis: first?.basis ?? null,
    basisGameId: first?.basis_game_id ?? null,
    basisGames: first?.basis_games ?? null,
    generatedAt: first?.generated_at ?? null,
    lines,
    pairs,
  };
}
