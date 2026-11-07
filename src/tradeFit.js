// Shape helper for GET /trade-fit (eyewall-pipeline's trade_fit.py ->
// trade_fit_players + trade_fit). Pure, unit-tested in
// __tests__/tradeFit.test.js.

// trade_fit_players row (or null) + trade_fit rows for one player ->
// { player, teams, generatedAt }. `player` is null when the player isn't in
// the population (unrated, ELC, too few games, out of season), and then
// `teams` is empty: the app hides the section. teams are ranked 1..31:
// { team, tier: 'strong'|'possible'|'long_shot', rank, slot, gap, needMet,
// windowMet, capState, reasons }, reasons passed through as the pipeline
// wrote them ([{ code, ...params }], codes translated by the app).
export function summarizeTradeFit(playerRow, fitRows) {
  if (!playerRow) return { player: null, teams: [], generatedAt: null };
  const p = playerRow;
  const player = {
    id: p.player_id,
    season: p.season,
    team: p.team,
    name: p.name ?? null,
    position: p.position,
    shoots: p.shoots ?? null,
    rating: p.rating,
    ratingBasis: p.rating_basis,
    gamesPlayed: p.games_played ?? 0,
    capHit: p.cap_hit ?? null,
    yearsLeft: p.years_left ?? null,
    expiresAfter: p.expires_after ?? null,
    expiryType: p.expiry_type ?? null,
    expiryTypeDerived: !!p.expiry_type_derived,
    rental: !!p.rental,
    clause: p.clause_kind ? { kind: p.clause_kind, listSize: p.clause_list_size ?? null } : null,
  };
  const teams = (fitRows || [])
    .map(r => ({
      team: r.team,
      tier: r.tier,
      rank: r.rank,
      slot: r.slot ?? null,
      gap: r.gap ?? null,
      needMet: !!r.need_met,
      windowMet: !!r.window_met,
      capState: r.cap_state,
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
    }))
    .sort((a, b) => a.rank - b.rank);
  return { player, teams, generatedAt: p.generated_at ?? null };
}
