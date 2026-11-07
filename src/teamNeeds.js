// Shape helper for GET /team-needs (eyewall-pipeline's team_needs.py ->
// team_needs). Pure, unit-tested in __tests__/teamNeeds.test.js.

// The order the app lists slots in: forwards, then D, then goalies.
export const SLOT_ORDER = ['F_TOP6_C', 'F_TOP6_W', 'F_BOT6_C', 'F_BOT6_W', 'D_TOP4', 'D_BOT2', 'G_1A', 'G_1B'];

// team_needs rows for one team -> { season, basis, basisGameId, generatedAt,
// slots }. Each slot: { slot, players, nPlayers, nRated, strength,
// weakestId, weakestRating, leagueRank, leagueTeams, need, rightShots, basis }.
// players: [{ id, name, pos, shoots, rating, ratingBasis, gp, filled,
// gamesStarted? }] -- rating is WAR per 82 (skaters) or GSAx per 60 (goalies),
// ratingBasis 'season' | 'last_season' | null (unrated). strength and
// leagueRank are null when too few of the slot's players are rated. `basis`
// at the top is the skater slots' projection basis ('last_game' |
// 'preseason'); goalie slots carry 'goalie_starts'. No rows -> basis null and
// no slots (the UI hides the tab). Unknown slot names sort last, not dropped.
export function summarizeTeamNeeds(rows) {
  const list = rows || [];
  const skater = list.find(r => r.basis && r.basis !== 'goalie_starts');
  const first = skater || list[0];
  const order = s => {
    const i = SLOT_ORDER.indexOf(s);
    return i === -1 ? SLOT_ORDER.length : i;
  };
  const slots = list
    .map(r => ({
      slot: r.slot,
      players: (r.players || []).map(p => ({
        id: p.id,
        name: p.name ?? String(p.id),
        pos: p.pos ?? null,
        shoots: p.shoots ?? null,
        rating: p.rating ?? null,
        ratingBasis: p.rating_basis ?? null,
        gp: p.gp ?? 0,
        filled: !!p.filled,
        ...(p.games_started != null ? { gamesStarted: p.games_started } : {}),
      })),
      nPlayers: r.n_players ?? (r.players || []).length,
      nRated: r.n_rated ?? 0,
      strength: r.strength ?? null,
      weakestId: r.weakest_id ?? null,
      weakestRating: r.weakest_rating ?? null,
      leagueRank: r.league_rank ?? null,
      leagueTeams: r.league_teams ?? null,
      need: !!r.need,
      rightShots: r.right_shots ?? null,
      basis: r.basis ?? null,
    }))
    .sort((a, b) => order(a.slot) - order(b.slot));
  return {
    season: first?.season ?? null,
    basis: skater?.basis ?? null,
    basisGameId: skater?.basis_game_id ?? null,
    generatedAt: first?.generated_at ?? null,
    slots,
  };
}
