// src/trades.js
// GET /trades/tree (nhl.js): one NHL trade and where every asset went next,
// from eyewall-pipeline's trades / trade_assets tables (trade_trees.py --
// ESPN's free-text trade entries parsed into players and picks, picks
// resolved against the NHL's own draft records, each received asset linked
// to the next trade its new team sent it on in via next_trade_id).
//
// fetchTradeTree() walks those links breadth-first from the trade that
// contains a given nhl_transactions row, one Supabase request per level
// (`get` is injected, so the Vitest suite drives it without the route
// harness), and also loads the trades that brought the root's outgoing
// assets in ("origins", one level back). Bounded by TREE_MAX_DEPTH levels
// and TREE_MAX_TRADES trades; an asset whose next trade wasn't loaded keeps
// its `next` id and the response says `truncated`.

export const TREE_MAX_DEPTH = 5;
export const TREE_MAX_TRADES = 30;

const TRADE_SELECT = 'trade_id,tx_date,teams,via,descriptions';
const ASSET_SELECT = [
  'trade_id', 'idx', 'from_team', 'to_team', 'asset_type', 'player_name', 'player_id', 'position',
  'rights', 'pick_year', 'pick_round', 'pick_conditional', 'pick_overall', 'pick_original_team',
  'pick_raw', 'pairing_uncertain', 'resolved_year', 'resolved_overall', 'drafted_player_name',
  'drafted_player_id', 'pick_note', 'next_trade_id',
].join(',');

// trade_trees.trade_id() is a 16-char sha1 prefix; anything else never goes
// into a PostgREST filter.
const TRADE_ID_RE = /^[0-9a-f]{16}$/;

function safeIds(ids) {
  return [...new Set(ids)].filter(id => typeof id === 'string' && TRADE_ID_RE.test(id));
}

export function shapeAsset(row) {
  const asset = {
    type: row.asset_type,
    from: row.from_team,
    to: row.to_team,
    next: row.next_trade_id || null,
  };
  if (row.asset_type === 'player') {
    Object.assign(asset, {
      name: row.player_name,
      position: row.position || null,
      rights: !!row.rights,
      playerId: row.player_id ?? null,
    });
  } else if (row.asset_type === 'pick') {
    asset.pick = {
      year: row.pick_year ?? null,
      round: row.pick_round ?? null,
      conditional: !!row.pick_conditional,
      overall: row.pick_overall ?? null,
      originalTeam: row.pick_original_team || null,
      uncertain: !!row.pairing_uncertain,
      raw: row.pick_raw || null,
      // null when resolved, else 'future' | 'not_traced' | 'several_possible'
      note: row.pick_note || null,
      resolvedYear: row.resolved_year ?? null,
      resolvedOverall: row.resolved_overall ?? null,
      draftedName: row.drafted_player_name || null,
      draftedId: row.drafted_player_id ?? null,
    };
  } else if (row.asset_type === 'unknown') {
    asset.raw = row.pick_raw || null;
  }
  return asset;
}

// One trades row + its trade_assets rows -> { id, date, teams, via,
// descriptions, sides: [{ team, received: [asset] }] }, sides in `teams` order.
export function shapeTrade(trade, assetRows) {
  const rows = [...(assetRows || [])].sort((a, b) => a.idx - b.idx);
  return {
    id: trade.trade_id,
    date: trade.tx_date,
    teams: trade.teams || [],
    via: trade.via || [],
    descriptions: trade.descriptions || [],
    sides: (trade.teams || []).map(team => ({
      team,
      received: rows.filter(r => r.to_team === team).map(shapeAsset),
    })),
  };
}

const NOT_FOUND = { found: false, root: null, trades: {}, origins: [], truncated: false };

// -> { found, root: <trade id>, trades: { <id>: shapeTrade() }, origins:
//      [{ id, date, teams, assets: [asset] }], truncated }
export async function fetchTradeTree(txId, get, { maxDepth = TREE_MAX_DEPTH, maxTrades = TREE_MAX_TRADES } = {}) {
  const roots = await get(`trades?select=${TRADE_SELECT}&source_tx_ids=cs.%7B${txId}%7D&limit=1`);
  if (!roots?.length) return NOT_FOUND;
  const rootId = roots[0].trade_id;

  const tradeRows = new Map([[rootId, roots[0]]]);
  const assetsByTrade = new Map();
  let frontier = safeIds([rootId]);
  let truncated = false;

  for (let depth = 1; frontier.length; depth++) {
    const assets = await get(
      `trade_assets?select=${ASSET_SELECT}&trade_id=in.(${frontier.join(',')})&order=trade_id,idx`
    );
    for (const id of frontier) assetsByTrade.set(id, []);
    for (const a of assets || []) assetsByTrade.get(a.trade_id)?.push(a);

    const nextIds = safeIds((assets || []).map(a => a.next_trade_id)).filter(id => !tradeRows.has(id));
    if (!nextIds.length) break;
    if (depth >= maxDepth || tradeRows.size + nextIds.length > maxTrades) {
      truncated = true;
      break;
    }
    const next = await get(`trades?select=${TRADE_SELECT}&trade_id=in.(${nextIds.join(',')})`);
    for (const t of next || []) tradeRows.set(t.trade_id, t);
    frontier = safeIds((next || []).map(t => t.trade_id));
  }

  // Origins: the earlier trades that brought in what the root trade sent out.
  const incoming = await get(`trade_assets?select=${ASSET_SELECT}&next_trade_id=eq.${rootId}`);
  const originIds = safeIds((incoming || []).map(a => a.trade_id));
  const originTrades = originIds.length
    ? await get(`trades?select=${TRADE_SELECT}&trade_id=in.(${originIds.join(',')})`)
    : [];
  const origins = (originTrades || [])
    .map(t => ({
      id: t.trade_id,
      date: t.tx_date,
      teams: t.teams || [],
      assets: (incoming || []).filter(a => a.trade_id === t.trade_id).map(shapeAsset),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const trades = {};
  for (const [id, t] of tradeRows) trades[id] = shapeTrade(t, assetsByTrade.get(id));
  return { found: true, root: rootId, trades, origins, truncated };
}
