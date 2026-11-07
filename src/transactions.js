// src/transactions.js
// Pure helpers for GET /transactions (nhl.js), which proxies
// eyewall-pipeline's nhl_transactions table (transactions.py, ESPN's NHL
// transactions feed, plus the trades wiki_trades.py adds from Wikipedia's
// cited season lists where ESPN has none). No imports, so the Vitest suite can test the pairing
// logic directly without the route harness.
//
// Why pairing is needed: ESPN posts each side of a trade as its own entry,
// one per team ("Acquired D X from Philadelphia in exchange for F Y." /
// "Acquired F Y from Pittsburgh Penguins for D X."). Shown raw, every trade
// appears twice in a league feed. Measured on 2025-26 (transactions.py's
// docstring): about three quarters of trade entries have their other half
// posted the same day, and nearly every unpaired one has no other half in
// ESPN's feed at all -- so an unpaired trade is shown as a single move,
// never guessed at.

// Rows fetched per request -- enough for a few weeks of league-wide moves
// in-season, and a team's whole recent history.
export const TRANSACTIONS_LIMIT = 150;

const DAY_MS = 86_400_000;

function daysApart(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

function isTrade(row) {
  return Array.isArray(row.categories) && row.categories.includes('trade');
}

// Where a row and its date come from (eyewall-pipeline's wiki_trades.py),
// only when there's something to say, so plain ESPN rows are unchanged:
//   source: 'wikipedia'  -- a trade ESPN's feed doesn't have, written from
//                           Wikipedia's cited season list
//   sourceUrl            -- that citation (NHL.com, a team site, media), or
//                           the one behind a corrected ESPN date
//   dateStatus: 'corrected'  -- ESPN's date replaced by the cited one
//               'espn_early' -- ESPN's date from its known early window
//                               (2021-01 .. 2024-06, ~5 days early), unconfirmed
export function provenance(row) {
  const out = {};
  if (row.source && row.source !== 'espn') out.source = row.source;
  if (row.source_url) out.sourceUrl = row.source_url;
  if (row.date_status) out.dateStatus = row.date_status;
  return out;
}

function side(row) {
  return { team: row.team, description: row.description, ...provenance(row) };
}

// Newest first; ties broken by id (higher = ingested later) so output order
// is stable across calls.
function byNewest(a, b) {
  if (a.tx_date !== b.tx_date) return a.tx_date < b.tx_date ? 1 : -1;
  return (b.id ?? 0) - (a.id ?? 0);
}

// nhl_transactions rows -> feed items, newest first:
//   { kind: 'trade', ids: [idA, idB], date, teams: [A, B], sides: [{team, description}, x2] }
//   { kind: 'move',  id, date, team, category, categories, counterparties, description }
// The row ids are what GET /trades/tree?tx= takes -- the app opens a trade's
// tree from either kind (an unpaired trade entry is still a trade there).
// A trade entry from team A naming B pairs with a trade entry from B naming
// A within `windowDays`. Each row is used at most once. `focusTeam` (the
// team whose feed this is) is put first in a pair's sides.
export function pairTransactions(rows, { windowDays = 2, focusTeam = null } = {}) {
  const sorted = [...(rows || [])].sort(byNewest);
  const used = new Set();
  const items = [];

  for (const row of sorted) {
    if (used.has(row.id)) continue;
    used.add(row.id);

    const counterparties = row.counterparties || [];
    if (isTrade(row) && counterparties.length) {
      const partner = sorted.find(other =>
        !used.has(other.id)
        && isTrade(other)
        && counterparties.includes(other.team)
        && (other.counterparties || []).includes(row.team)
        && daysApart(other.tx_date, row.tx_date) <= windowDays);
      if (partner) {
        used.add(partner.id);
        let sides = [side(row), side(partner)];
        if (focusTeam && sides[1].team === focusTeam) sides = [sides[1], sides[0]];
        // the date from a half whose date isn't an unconfirmed ESPN one
        const dated = [row, partner].find(r => r.date_status !== 'espn_early') || row;
        const item = {
          kind: 'trade', ids: [row.id, partner.id], date: dated.tx_date, teams: sides.map(s => s.team), sides,
        };
        if (row.date_status === 'espn_early' && partner.date_status === 'espn_early') item.dateStatus = 'espn_early';
        items.push(item);
        continue;
      }
    }

    items.push({
      kind: 'move',
      id: row.id,
      date: row.tx_date,
      team: row.team,
      category: row.primary_category || 'other',
      categories: row.categories || [],
      counterparties,
      description: row.description,
      ...provenance(row),
    });
  }
  return items;
}
