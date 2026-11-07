// Shape helpers for GET /trade-candidacy and /trade-candidacy/board
// (eyewall-pipeline's trade_candidacy.py -> trade_candidacy). Pure,
// unit-tested in __tests__/tradeCandidacy.test.js.
//
// The table's model_p is never passed on: the backtest didn't calibrate well
// enough to show a percentage, so the app shows the tier ('several' |
// 'some') and the signals behind it. Untiered players (no signal, no public
// cap hit, or below the cuts) aren't shown at all.

function shapePlayer(r) {
  return {
    id: r.player_id,
    season: r.season,
    team: r.team,
    name: r.name ?? null,
    position: r.position,
    gamesPlayed: r.games_played ?? 0,
    tier: r.tier,
    rank: r.rank ?? null,
    signals: Array.isArray(r.signals) ? r.signals : [],
    capHit: r.cap_hit ?? null,
    yearsLeft: r.years_left ?? null,
    expiryType: r.expiry_type ?? null,
    expiryTypeDerived: !!r.expiry_type_derived,
    extended: !!r.extended,
    clause: r.clause_kind ? { kind: r.clause_kind, listSize: r.clause_list_size ?? null } : null,
  };
}

const TIERS = new Set(['several', 'some']);
const shown = r => r && TIERS.has(r.tier) && Array.isArray(r.signals) && r.signals.length > 0;

// The player's EyeWall AI paragraph (eyewall-pipeline ai_trade_candidacy.py
// -> trade_candidacy_ai, trade fit scope §5.5), or null: none written, an
// empty one, or one from another season than the candidacy row.
function shapeAi(aiRow, row) {
  const text = typeof aiRow?.paragraph === 'string' ? aiRow.paragraph.trim() : '';
  if (!text || aiRow.season !== row.season) return null;
  return { text, generatedAt: aiRow.generated_at ?? null };
}

// One trade_candidacy row (or null), plus its trade_candidacy_ai row for the
// request's locale (or null) -> { player, ai, asOf, deadline, generatedAt }.
// player is null when the row is missing or untiered: the app hides the
// section. ai is the paragraph ({ text, generatedAt }) or null, and always
// null without a player.
export function summarizeCandidacy(row, aiRow = null) {
  if (!shown(row)) return { player: null, ai: null, asOf: null, deadline: null, generatedAt: null };
  return {
    player: shapePlayer(row),
    ai: shapeAi(aiRow, row),
    asOf: row.as_of ?? null,
    deadline: row.deadline ?? null,
    generatedAt: row.generated_at ?? null,
  };
}

// Tiered trade_candidacy rows (+ optional trade_fit rows for one team) ->
// { players, asOf, deadline, generatedAt, fitTeam }. Players are ranked by the
// model (rank 1 first); with fitTeam each carries `fit`: that team's trade
// fit tier for him ('strong' | 'possible' | 'long_shot'), or null when he has
// no fit row (outside the fit population, or he's on that team).
export function summarizeBoard(rows, fitRows = null, fitTeam = null) {
  const players = (rows || []).filter(shown).map(shapePlayer);
  players.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const first = (rows || []).find(shown);
  if (fitTeam) {
    const fit = new Map((fitRows || []).map(f => [f.player_id, f.tier]));
    for (const p of players) p.fit = fit.get(p.id) ?? null;
  }
  return {
    players,
    asOf: first?.as_of ?? null,
    deadline: first?.deadline ?? null,
    generatedAt: first?.generated_at ?? null,
    fitTeam: fitTeam || null,
  };
}
