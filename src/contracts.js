// src/contracts.js
// GET /contracts, /contracts/player/:id, /contracts/summary and /config/cap
// (nhl.js): NHL player contracts from eyewall-pipeline's nhl_contracts*
// tables (nhl_contracts.py, a nightly mirror of the open nhl-contracts
// dataset, github.com/ehlersio/nhl-contracts, CC0). The Supabase readers
// are injected (`get` one page, `getAll` every page) so the Vitest suite
// drives these builders without the route harness, as trades.js does.
//
// Dataset facts these builders work around (nhl_contracts.py's docstring):
// - a contract row's `team` is the team that signed it, so a player traded
//   mid-contract is not found by `team=eq.X`. The team view therefore reads
//   the contracts of everyone on the team's current NHL roster (by
//   player_id) plus the rows signed by the team, and says which is which
//   (`onRoster`).
// - the same contract can appear twice: an id-keyed row (tier B, from the
//   club) and a name-keyed row (tier E, archived CapFriendly) with slightly
//   different figures, so a player can have several `is_current` rows. One
//   contract is chosen per player (`pickContract`: better tier, more
//   sources, id-keyed), and the season's cap hit comes from any of the
//   player's season rows for that season (`seasonCapHit`), best tier first,
//   since the id-keyed row often has no season breakdown.
// - cap space is not computable: no retained salary, buyouts or LTIR, and
//   coverage is partial (`nhl_contract_gaps` says who has no public
//   figure). The team summary gives `rosterCapHit` (the sum over roster
//   players with a figure) and the cap limits; the app labels it as such.

export const CONTRACT_SELECT = [
  'contract_key', 'player_id', 'player_name', 'team', 'signed_at', 'contract_type', 'term_years',
  'aav_usd', 'cap_hit_usd', 'total_usd', 'one_way', 'start_season', 'end_season', 'expiry_status',
  'expiry_type', 'expiry_type_derived', 'is_current', 'years_left', 'n_sources', 'best_tier',
  'conflicts', 'flags', 'dataset_updated_at',
].join(',');
export const SEASON_SELECT = [
  'contract_key', 'player_id', 'team', 'season', 'cap_hit_usd', 'aav_usd', 'base_salary_usd',
  'signing_bonus_usd', 'performance_bonus_usd', 'total_salary_usd', 'minors_salary_usd', 'one_way',
  'clause', 'best_tier',
].join(',');
export const CLAUSE_SELECT = 'contract_key,player_id,kind,season_from,season_to,list_size,list_type,best_tier';
export const GAP_SELECT = 'player_id,player_name,team,gap,status,last_contract_end';
export const CAP_SELECT = 'season,cap_ceiling,cap_floor,min_salary,updated_at';

// Dataset tiers, best first. A-C are official sources (club release,
// NHL.com, ESPN wire); D-E are reported (PuckPedia posts, archived
// CapFriendly).
const TIER_RANK = { A: 0, B: 1, C: 2, D: 3, E: 4 };
export const OFFICIAL_TIERS = new Set(['A', 'B', 'C']);

const SEASON_RE = /^\d{4}-\d{2}$/;
const ID_KEYED_RE = /^\d+\|/;

// 20262027 -> '2026-27'
export function seasonLabel(seasonId) {
  const s = String(seasonId || '');
  if (SEASON_RE.test(s)) return s;
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(6, 8)}`;
}

// A `season=` query value, or null when it is not 'YYYY-YY'.
export function safeSeasonLabel(value) {
  const s = String(value || '').trim();
  return SEASON_RE.test(s) ? s : null;
}

function tierRank(tier) {
  return TIER_RANK[tier] ?? TIER_RANK.E + 1;
}

// The contract to show for a player who has several rows covering the same
// season: better tier, then more sources, then the id-keyed row (the one
// the dataset tied to an NHL id itself), then the later signing.
export function pickContract(rows, preferTeam = null) {
  let best = null;
  for (const r of rows || []) {
    if (!best || compareContracts(r, best, preferTeam) < 0) best = r;
  }
  return best;
}

function compareContracts(a, b, preferTeam) {
  if (preferTeam && (a.team === preferTeam) !== (b.team === preferTeam)) return a.team === preferTeam ? -1 : 1;
  if (tierRank(a.best_tier) !== tierRank(b.best_tier)) return tierRank(a.best_tier) - tierRank(b.best_tier);
  if ((a.n_sources || 0) !== (b.n_sources || 0)) return (b.n_sources || 0) - (a.n_sources || 0);
  const aId = ID_KEYED_RE.test(a.contract_key || ''), bId = ID_KEYED_RE.test(b.contract_key || '');
  if (aId !== bId) return aId ? -1 : 1;
  return String(b.signed_at || '').localeCompare(String(a.signed_at || ''));
}

// The cap hit to show for `season`: the best-tier season row any of the
// player's contracts has for it (`source: 'season'`), else the chosen
// contract's cap_hit_usd ('contract'), else its aav_usd ('aav'), else null.
export function seasonCapHit(contract, seasonRows, season) {
  const rows = (seasonRows || []).filter(r => r.season === season && r.cap_hit_usd != null);
  rows.sort((a, b) => tierRank(a.best_tier) - tierRank(b.best_tier));
  if (rows.length) return { capHit: rows[0].cap_hit_usd, source: 'season', tier: rows[0].best_tier };
  if (contract?.cap_hit_usd != null) return { capHit: contract.cap_hit_usd, source: 'contract', tier: contract.best_tier };
  if (contract?.aav_usd != null) return { capHit: contract.aav_usd, source: 'aav', tier: contract.best_tier };
  return { capHit: null, source: null, tier: null };
}

// Does `season` fall inside the contract's span? Rows without a span never do.
export function coversSeason(row, season) {
  return !!(row.start_season && row.end_season && row.start_season <= season && season <= row.end_season);
}

// 'YYYY-YY' seasons after `season` until end_season, 0 once it has ended.
export function yearsLeftFor(endSeason, season) {
  if (!endSeason || !season) return null;
  return Math.max(parseInt(endSeason.slice(0, 4), 10) - parseInt(season.slice(0, 4), 10), 0);
}

export function shapeClause(row) {
  return {
    kind: row.kind,
    from: row.season_from || null,
    to: row.season_to || null,
    listSize: row.list_size ?? null,
    listType: row.list_type || null,
    tier: row.best_tier || null,
  };
}

// Clauses of all the player's rows for the contract, deduped.
function clausesFor(keys, clauseRows) {
  const seen = new Set();
  const out = [];
  for (const row of clauseRows || []) {
    if (!keys.has(row.contract_key)) continue;
    const c = shapeClause(row);
    const k = `${c.kind}|${c.from}|${c.to}|${c.listSize}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function shapeSeasonRow(row) {
  return {
    season: row.season,
    capHit: row.cap_hit_usd ?? null,
    aav: row.aav_usd ?? null,
    baseSalary: row.base_salary_usd ?? null,
    signingBonus: row.signing_bonus_usd ?? null,
    performanceBonus: row.performance_bonus_usd ?? null,
    totalSalary: row.total_salary_usd ?? null,
    minorsSalary: row.minors_salary_usd ?? null,
    oneWay: row.one_way ?? null,
    clause: row.clause || null,
    tier: row.best_tier || null,
  };
}

// One contract as the app sees it. `season` decides capHit and yearsLeft
// (so a past or future season can be asked for); `extras` are merged in.
export function shapeContract(contract, { season, seasonRows = [], clauseRows = [], keys = null } = {}) {
  const keySet = keys || new Set([contract.contract_key]);
  const hit = seasonCapHit(contract, seasonRows, season);
  return {
    contractKey: contract.contract_key,
    playerId: contract.player_id,
    name: contract.player_name,
    team: contract.team,
    capHit: hit.capHit,
    capHitSource: hit.source,
    capHitTier: hit.tier,
    aav: contract.aav_usd ?? null,
    totalValue: contract.total_usd ?? null,
    termYears: contract.term_years ?? null,
    startSeason: contract.start_season || null,
    expiresAfter: contract.end_season || null,
    yearsLeft: season ? yearsLeftFor(contract.end_season, season) : contract.years_left ?? null,
    isCurrent: !!contract.is_current,
    expiryType: contract.expiry_type || null,
    expiryTypeDerived: !!contract.expiry_type_derived,
    expiryStatus: contract.expiry_status || null,
    contractType: contract.contract_type || null,
    oneWay: contract.one_way ?? null,
    signedAt: contract.signed_at || null,
    tier: contract.best_tier || null,
    official: OFFICIAL_TIERS.has(contract.best_tier),
    sources: contract.n_sources ?? null,
    conflicts: contract.conflicts || null,
    clauses: clausesFor(keySet, clauseRows),
  };
}

// Roster payload (/roster/{team}/current) -> [{ id, name, position }]
export function rosterPlayers(roster) {
  const out = [];
  for (const group of ['forwards', 'defensemen', 'goalies']) {
    for (const p of roster?.[group] || []) {
      if (!p?.id) continue;
      out.push({
        id: Number(p.id),
        name: [p.firstName?.default, p.lastName?.default].filter(Boolean).join(' ') || null,
        position: p.positionCode || null,
      });
    }
  }
  return out;
}

function inList(ids) {
  return `in.(${ids.join(',')})`;
}

function latestStamp(rows) {
  let max = null;
  for (const r of rows || []) {
    if (r.dataset_updated_at && (!max || r.dataset_updated_at > max)) max = r.dataset_updated_at;
  }
  return max;
}

function expiringCounts(rows) {
  const counts = { ufa: 0, rfa: 0, unknown: 0 };
  for (const r of rows) {
    if (r.yearsLeft !== 0) continue;
    if (r.expiryType === 'UFA') counts.ufa += 1;
    else if (r.expiryType === 'RFA') counts.rfa += 1;
    else counts.unknown += 1;
  }
  return counts;
}

// Cap limits for a season, from nhl_cap_limits rows; null when the league
// has not announced that season's figures (nothing is projected).
export function capLimitsFor(capRows, season) {
  const row = (capRows || []).find(r => r.season === season);
  return row ? { ceiling: row.cap_ceiling, floor: row.cap_floor, minSalary: row.min_salary } : null;
}

export function shapeCapLimits(capRows, currentSeason) {
  const seasons = {};
  for (const r of capRows || []) {
    seasons[r.season] = { ceiling: r.cap_ceiling, floor: r.cap_floor, minSalary: r.min_salary };
  }
  return { current: currentSeason, seasons };
}

// GET /contracts: a team's contracts for `season`.
//   roster  the team's /roster/{team}/current payload (or null when it
//           could not be fetched: then only the team-signed rows are read)
// Returns { team, season, asOf, rows, missing, summary, unavailable }:
//   rows     one per player (shapeContract + position, onRoster), roster
//            players first, then the team's signed-but-off-roster deals;
//            cap hit descending within each
//   missing  roster players with no contract row for the season, with the
//            dataset's gap reason when it has one ('no_contract' otherwise)
//   summary  { rosterCapHit, rosterCount, rosterWithFigure, offRosterCount,
//              capLimits, expiring: { ufa, rfa, unknown } }
//   unavailable  true when there is nothing to show (no rows at all)
export async function buildTeamContracts({ get, getAll, team, season, roster }) {
  const players = rosterPlayers(roster);
  const rosterIds = players.map(p => p.id);
  const spanFilter = `start_season=lte.${season}&end_season=gte.${season}`;
  const scope = rosterIds.length ? `or=(team.eq.${team},player_id.${inList(rosterIds)})` : `team=eq.${team}`;
  const contracts = await getAll(`nhl_contracts?select=${CONTRACT_SELECT}&${scope}&${spanFilter}&order=contract_key`);

  const byPlayer = new Map();
  for (const r of contracts) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  }
  const playerIds = [...byPlayer.keys()];
  const [seasonRows, clauseRows, gapRows, capRows] = playerIds.length || rosterIds.length
    ? await Promise.all([
      playerIds.length ? getAll(`nhl_contract_seasons?select=${SEASON_SELECT}&player_id=${inList(playerIds)}&season=eq.${season}&order=id`) : [],
      playerIds.length ? getAll(`nhl_contract_clauses?select=${CLAUSE_SELECT}&player_id=${inList(playerIds)}&order=id`) : [],
      get(`nhl_contract_gaps?select=${GAP_SELECT}&team=eq.${team}&order=player_id`),
      get(`nhl_cap_limits?select=${CAP_SELECT}&order=season`),
    ])
    : [[], [], [], await get(`nhl_cap_limits?select=${CAP_SELECT}&order=season`)];

  const rosterById = new Map(players.map(p => [p.id, p]));
  const rows = [];
  for (const [playerId, playerRows] of byPlayer) {
    const contract = pickContract(playerRows, team);
    const keys = new Set(playerRows.map(r => r.contract_key));
    const onRoster = rosterById.has(playerId);
    rows.push({
      ...shapeContract(contract, {
        season,
        seasonRows: seasonRows.filter(r => r.player_id === playerId),
        clauseRows,
        keys,
      }),
      position: rosterById.get(playerId)?.position || null,
      onRoster,
      alternates: playerRows.length - 1,
    });
  }
  rows.sort((a, b) => (a.onRoster !== b.onRoster ? (a.onRoster ? -1 : 1) : (b.capHit || 0) - (a.capHit || 0)));

  const gapByPlayer = new Map((gapRows || []).map(g => [g.player_id, g]));
  const missing = players
    .filter(p => !byPlayer.has(p.id))
    .map(p => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      gap: gapByPlayer.get(p.id)?.gap || 'no_contract',
      status: gapByPlayer.get(p.id)?.status || null,
    }));

  const rosterRows = rows.filter(r => r.onRoster);
  const withFigure = rosterRows.filter(r => r.capHit != null);
  const summary = {
    rosterCapHit: withFigure.reduce((s, r) => s + r.capHit, 0),
    rosterCount: players.length,
    rosterWithFigure: withFigure.length,
    rosterWithoutFigure: players.length - withFigure.length,
    offRosterCount: rows.length - rosterRows.length,
    capLimits: capLimitsFor(capRows, season),
    expiring: expiringCounts(rosterIds.length ? rosterRows : rows),
  };

  return {
    team,
    season,
    asOf: latestStamp(contracts),
    rosterKnown: rosterIds.length > 0,
    rows,
    missing,
    summary,
    unavailable: rows.length === 0,
  };
}

// GET /contracts/player/:id: every contract the dataset has for a player,
// newest first, each with its season rows and clauses; `current` is the
// chosen row for `season` (shapeContract), or null.
export async function buildPlayerContracts({ get, playerId, season }) {
  const [contracts, seasonRows, clauseRows] = await Promise.all([
    get(`nhl_contracts?select=${CONTRACT_SELECT}&player_id=eq.${playerId}&order=start_season.desc.nullslast,signed_at.desc`),
    get(`nhl_contract_seasons?select=${SEASON_SELECT}&player_id=eq.${playerId}&order=season`),
    get(`nhl_contract_clauses?select=${CLAUSE_SELECT}&player_id=eq.${playerId}&order=id`),
  ]);
  const history = contracts.map(c => ({
    ...shapeContract(c, { season: null, seasonRows: [], clauseRows }),
    yearsLeft: c.years_left ?? null,
    seasons: seasonRows.filter(r => r.contract_key === c.contract_key).map(shapeSeasonRow),
  }));
  const covering = contracts.filter(c => coversSeason(c, season));
  const chosen = pickContract(covering);
  const current = chosen
    ? shapeContract(chosen, {
      season,
      seasonRows: seasonRows.filter(r => covering.some(c => c.contract_key === r.contract_key)),
      clauseRows,
      keys: new Set(covering.map(c => c.contract_key)),
    })
    : null;
  return {
    playerId: Number(playerId),
    season,
    asOf: latestStamp(contracts),
    current,
    history,
    unavailable: contracts.length === 0,
  };
}

// GET /contracts/summary: every team's contracts for `season`, grouped by
// the SIGNING team (the dataset has no "current team"), so a player traded
// mid-contract counts for the team that signed him. Good enough for a
// league table of commitments and expiring deals; the per-team view
// (/contracts) is the one that follows the real roster.
export async function buildLeagueSummary({ getAll, get, season }) {
  const [contracts, seasonRows, capRows] = await Promise.all([
    getAll(`nhl_contracts?select=${CONTRACT_SELECT}&start_season=lte.${season}&end_season=gte.${season}&order=contract_key`),
    getAll(`nhl_contract_seasons?select=${SEASON_SELECT}&season=eq.${season}&order=id`),
    get(`nhl_cap_limits?select=${CAP_SELECT}&order=season`),
  ]);
  const byTeamPlayer = new Map();
  for (const r of contracts) {
    if (!r.team) continue;
    const key = `${r.team}|${r.player_id}`;
    if (!byTeamPlayer.has(key)) byTeamPlayer.set(key, []);
    byTeamPlayer.get(key).push(r);
  }
  const teams = new Map();
  for (const [key, rows] of byTeamPlayer) {
    const team = key.split('|')[0];
    const contract = pickContract(rows);
    const shaped = shapeContract(contract, {
      season,
      seasonRows: seasonRows.filter(r => r.player_id === contract.player_id),
      keys: new Set(rows.map(r => r.contract_key)),
    });
    if (!teams.has(team)) {
      teams.set(team, { team, contracts: 0, withFigure: 0, capHitTotal: 0, expiring: { ufa: 0, rfa: 0, unknown: 0 } });
    }
    const t = teams.get(team);
    t.contracts += 1;
    if (shaped.capHit != null) {
      t.withFigure += 1;
      t.capHitTotal += shaped.capHit;
    }
    if (shaped.yearsLeft === 0) {
      if (shaped.expiryType === 'UFA') t.expiring.ufa += 1;
      else if (shaped.expiryType === 'RFA') t.expiring.rfa += 1;
      else t.expiring.unknown += 1;
    }
  }
  return {
    season,
    basis: 'signing_team',
    asOf: latestStamp(contracts),
    capLimits: capLimitsFor(capRows, season),
    teams: [...teams.values()].sort((a, b) => b.capHitTotal - a.capHitTotal),
    unavailable: contracts.length === 0,
  };
}
