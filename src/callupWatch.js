// Call-up watch: which of an NHL team's AHL affiliate players are next in
// line, by position, given who's out. Pure; the /nhl/callup-watch route in
// nhl.js gathers the inputs. Unit-tested in __tests__/callupWatch.test.js.
//
// A ranking, not a prediction. Nothing here estimates a probability: there
// is no contract or waiver data (both decide who can be recalled), and no
// model has been fit to past call-ups yet. What it shows is all real data:
//   - who's out, per position group (F/D/G), from player_injuries;
//   - candidates: affiliate players who hold the team's NHL rights (the
//     NHL's own /prospects list, matched by name and birth date -- there is
//     no NHL<->AHL player id link anywhere) or who moved between the two
//     clubs in the last year (nhl_transactions, which names players only in
//     free text), so an NHL-contracted veteran assigned down is included;
//   - ranked by AHL points per game over this season and last (save % for
//     goalies) -- this season alone is a handful of games in October;
//   - with each player's last 5 games and recent call-ups beside it.

export const GROUPS = ['F', 'D', 'G'];
export const MIN_GP_TO_RANK = 5;
const LAST_N = 5;

// 'Felix Unger Sörum' / "Brind’Amour" / 'Charles-Alexis' -> comparable keys:
// accents stripped, case folded, everything but letters dropped.
export function nameKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

export function positionGroup(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'G') return 'G';
  if (p === 'D' || p === 'LD' || p === 'RD') return 'D';
  return p ? 'F' : null; // C, L, R, LW, RW, F
}

// AHL roster rows matched to the NHL team's prospects: same birth date and
// last name (first names drift -- "Charles-Alexis" vs "Charles Alexis"), or
// the same full name when either side has no birth date.
// -> Map(ahlPlayerId -> prospect)
export function matchProspects(ahlPlayers, prospects) {
  const byBirthLast = new Map();
  const byFull = new Map();
  for (const p of prospects || []) {
    const first = p.firstName?.default ?? p.firstName;
    const last = p.lastName?.default ?? p.lastName;
    if (p.birthDate) byBirthLast.set(`${p.birthDate}|${nameKey(last)}`, p);
    byFull.set(nameKey(`${first}${last}`), p);
  }
  const out = new Map();
  for (const a of ahlPlayers || []) {
    const hit = (a.birth_date && byBirthLast.get(`${a.birth_date}|${nameKey(a.last_name)}`))
      || byFull.get(nameKey(`${a.first_name}${a.last_name}`));
    if (hit) out.set(a.player_id, hit);
  }
  return out;
}

// This team's transactions in the window that name the player (full name,
// accent- and punctuation-blind). A recall reads "Recalled F Bradly Nadeau
// from Chicago (AHL)."; several names can share one entry.
export function movesNaming(player, transactions) {
  const key = nameKey(`${player.first_name}${player.last_name}`);
  if (key.length < 6) return [];
  return (transactions || []).filter(t => nameKey(t.description).includes(key));
}

const isRecall = t => (t.categories || []).includes('recall') || t.primary_category === 'recall';

function sumSkater(rows) {
  const s = { gp: 0, goals: 0, assists: 0, points: 0 };
  for (const r of rows) {
    s.gp += r.gp || 0; s.goals += r.goals || 0; s.assists += r.assists || 0; s.points += r.points || 0;
  }
  return s;
}

function sumGoalie(rows) {
  const s = { gp: 0, saves: 0, shotsAgainst: 0, goalsAgainst: 0 };
  for (const r of rows) {
    s.gp += r.gp || 0;
    s.saves += r.saves || 0;
    s.shotsAgainst += r.shots_against || 0;
    s.goalsAgainst += r.goals_against || 0;
  }
  return s;
}

const svPct = s => (s.shotsAgainst > 0 ? Math.round((s.saves / s.shotsAgainst) * 1000) / 1000 : null);
const perGame = (n, gp) => (gp > 0 ? Math.round((n / gp) * 100) / 100 : null);

/**
 * @param {object} p
 * @param {string} p.team                 NHL abbr
 * @param {Array}  p.injuries             player_injuries rows (team's)
 * @param {object} p.nhlPositions         { [nhlPlayerId]: positionCode }
 * @param {object} p.nhlPositionsByName   { [nameKey(name)]: positionCode }, for
 *                                        injury rows with no NHL id
 * @param {Array}  p.prospects            NHL /prospects players, flattened
 * @param {Array}  p.nhlRoster            NHL roster players now ({id, firstName,
 *                                        lastName, birthDate, positionCode})
 * @param {Array}  p.ahlPlayers           ahl_players rows on the affiliate
 * @param {Array}  p.skaterSeasons        ahl_player_seasons rows (cur + prev)
 * @param {Array}  p.goalieSeasons        ahl_goalie_seasons rows (cur + prev)
 * @param {Array}  p.skaterBox            ahl_skater_game_box rows, newest first
 * @param {Array}  p.goalieBox            ahl_goalie_game_box rows, newest first
 * @param {Array}  p.transactions         nhl_transactions rows (team's, last year)
 * @param {number} p.currentSeason        AHL season_id
 * @param {number} p.previousSeason       AHL season_id (last regular season)
 */
export function buildCallupWatch(p) {
  const rights = matchProspects(p.ahlPlayers, p.prospects);
  // Affiliate players who are on the NHL roster right now (recalled, or an
  // NHL player whose AHL record still lists the affiliate after a
  // conditioning stint): listed as already up, not as candidates.
  const upNow = matchProspects(p.ahlPlayers, p.nhlRoster);
  const up = { F: [], D: [], G: [] };

  // Injuries. ESPN files an NHL-contracted player hurt while assigned to
  // the AHL under the NHL team too (Toronto's Villeneuve and Webber,
  // "ir-nr", 2026-10): he doesn't open an NHL spot, and can't be called up.
  // Matched by name -- ESPN rows carry an NHL id only when it resolved.
  const affiliateByName = new Map((p.ahlPlayers || [])
    .filter(a => !upNow.has(a.player_id))
    .map(a => [nameKey(`${a.first_name}${a.last_name}`), a]));
  const out = { F: [], D: [], G: [] };
  const hurt = { F: [], D: [], G: [] };
  const unplaced = [];
  const hurtIds = new Set();
  for (const inj of p.injuries || []) {
    const entry = {
      playerId: inj.player_id ?? null,
      name: inj.player_name,
      status: inj.status || null,
      injuryType: inj.injury_type || null,
      returnDate: inj.return_date || null,
    };
    const onAffiliate = affiliateByName.get(nameKey(inj.player_name));
    if (onAffiliate) {
      const g = positionGroup(onAffiliate.position);
      if (g) hurt[g].push(entry);
      hurtIds.add(onAffiliate.player_id);
      continue;
    }
    const group = positionGroup(p.nhlPositions?.[inj.player_id] ?? p.nhlPositionsByName?.[nameKey(inj.player_name)]);
    if (group) out[group].push(entry);
    else unplaced.push(entry); // position unknown -- shown, but under no group
  }
  const seasonsOf = (rows, id) => (rows || []).filter(r => r.player_id === id);
  const cur = r => r.season_id === p.currentSeason;
  const prev = r => r.season_id === p.previousSeason;

  const candidates = [];
  for (const a of p.ahlPlayers || []) {
    const group = positionGroup(a.position);
    if (!group) continue;
    const prospect = rights.get(a.player_id) || null;
    const moves = movesNaming(a, p.transactions);
    if (upNow.has(a.player_id)) {
      up[group].push({ ahlPlayerId: a.player_id, nhlPlayerId: upNow.get(a.player_id).id, name: `${a.first_name || ''} ${a.last_name || ''}`.trim(), position: a.position || null });
      continue;
    }
    if (!prospect && !moves.length) continue;
    if (hurtIds.has(a.player_id)) continue; // listed under `hurt` instead

    const recalls = moves.filter(isRecall).map(t => ({ date: t.tx_date, description: t.description }));
    const base = {
      ahlPlayerId: a.player_id,
      nhlPlayerId: prospect?.id ?? null,
      name: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
      position: a.position || null,
      group,
      jersey: a.jersey_number ?? null,
      birthDate: a.birth_date || prospect?.birthDate || null,
      holdsRights: !!prospect,
      recalls,
      // Why a player without the team's rights is listed: his latest move
      // between the clubs (transactions come newest first).
      lastMove: moves[0] ? { date: moves[0].tx_date, description: moves[0].description } : null,
    };

    if (group === 'G') {
      const rows = seasonsOf(p.goalieSeasons, a.player_id);
      const c = sumGoalie(rows.filter(cur));
      const pv = sumGoalie(rows.filter(prev));
      const both = sumGoalie([...rows.filter(cur), ...rows.filter(prev)]);
      const lastRows = (p.goalieBox || []).filter(r => r.player_id === a.player_id && (r.shots_against || r.toi_seconds)).slice(0, LAST_N);
      const last = sumGoalie(lastRows.map(r => ({ gp: 1, saves: r.saves, shots_against: r.shots_against, goals_against: r.goals_against })));
      candidates.push({
        ...base,
        current: { gp: c.gp, svPct: svPct(c) },
        previous: { gp: pv.gp, svPct: svPct(pv) },
        combined: { gp: both.gp, svPct: svPct(both) },
        lastGames: { gp: last.gp, svPct: svPct(last) },
        metric: svPct(both),
      });
    } else {
      const rows = seasonsOf(p.skaterSeasons, a.player_id);
      const c = sumSkater(rows.filter(cur));
      const pv = sumSkater(rows.filter(prev));
      const both = sumSkater([...rows.filter(cur), ...rows.filter(prev)]);
      const last = sumSkater((p.skaterBox || []).filter(r => r.player_id === a.player_id).slice(0, LAST_N).map(r => ({ ...r, gp: 1 })));
      candidates.push({
        ...base,
        current: c,
        previous: pv,
        combined: { gp: both.gp, points: both.points, pointsPerGame: perGame(both.points, both.gp) },
        lastGames: { gp: last.gp, goals: last.goals, assists: last.assists, points: last.points },
        metric: perGame(both.points, both.gp),
      });
    }
  }

  // Ranked players first (enough games to mean something), best metric
  // first; then everyone under the games bar, most games first.
  const ranked = c => c.combined.gp >= MIN_GP_TO_RANK && c.metric != null;
  const order = (a, b) => (ranked(b) - ranked(a))
    || (ranked(a) ? b.metric - a.metric : b.combined.gp - a.combined.gp)
    || b.recalls.length - a.recalls.length;

  const groups = {};
  for (const g of GROUPS) {
    groups[g] = {
      out: out[g],
      upNow: up[g],
      hurt: hurt[g],
      candidates: candidates.filter(c => c.group === g).sort(order).map(c => {
        const row = { ...c, ranked: ranked(c) };
        delete row.metric; // sort key only
        return row;
      }),
    };
  }
  return { team: p.team, minGamesToRank: MIN_GP_TO_RANK, groups, unplaced };
}
