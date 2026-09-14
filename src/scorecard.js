// Shape helper for GET /scorecard (eyewall-pipeline's prediction_scorecard.py
// -> prediction_scorecard). Pure, unit-tested in __tests__/scorecard.test.js.

const MODELS = ['game_winner', 'starting_goalie', 'playoff_odds'];
const KINDS = ['live', 'backtest'];

// prediction_scorecard rows -> { models: { <model>: { live, backtest } },
// updatedAt }. For each model, the most recent period of each kind wins
// ('2026-27' sorts after '2025-26'), so a new season's live row takes over
// from last season's. Unknown models/kinds are ignored; a model with no rows
// is left out. updatedAt is the newest updated_at among the rows kept.
export function summarizeScorecard(rows) {
  const models = {};
  for (const r of rows || []) {
    if (!MODELS.includes(r.model) || !KINDS.includes(r.kind)) continue;
    const slot = (models[r.model] ||= { live: null, backtest: null });
    const prev = slot[r.kind];
    if (!prev || String(r.period) > String(prev.period)) slot[r.kind] = r;
  }
  let updatedAt = null;
  for (const slot of Object.values(models)) {
    for (const r of [slot.live, slot.backtest]) {
      if (r?.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
    }
  }
  return { models, updatedAt };
}
