/**
 * hockeytechBracket.js — EyeWall Analytics Worker
 *
 * Calder Cup (AHL) and Kelly Cup (ECHL) brackets, contract C11: pure
 * builders behind hockeytech.js's GET /{league}/bracket and
 * /{league}/bracket/projected. Unit-tested on real feed payloads in
 * __tests__/hockeytech-bracket.test.js.
 *
 * Sources (probed 2026-10-07):
 *   - HockeyTech `feed=modulekit&view=brackets&season_id=<playoff id>`:
 *     every round and series (letters, names, team1/team2, team1_wins/
 *     team2_wins, games). `winner` is blank even for finished series and
 *     there are no seeds; a season with no playoffs yet has `rounds: []`.
 *   - HockeyTech `feed=statviewfeed&view=teams&groupTeamsBy=division`:
 *     the standings, one section per division in the league's own order.
 *     A team's seed is its rank in its division (both leagues seed within
 *     the division; the 2026 brackets match the final 2025-26 division
 *     ranks exactly).
 *
 * PLAYOFF_FORMATS holds only formats verified from the leagues' own
 * publications; a playoff year without an entry has no projection (no
 * made-up rules) and its real bracket's series lengths come from the feed
 * alone.
 */

// Keyed by league, then by the playoffs' calendar year.
//   bestOf      -- series length per round, first round first
//   qualify     -- { [division]: { teams, byes } } (division names without
//                  the word "Division"), or `perDivision` for every division
//   firstRound  -- the first round's name
export const PLAYOFF_FORMATS = {
  ahl: {
    // https://theahl.com/qualification-rules ("2025-26 AHL Qualification
    // Rules"): top 6 of 8 in the Atlantic, top 5 of 7 in the North and
    // Central, top 7 of 10 in the Pacific (23 teams); byes for the top 2
    // (Atlantic), 3 (North, Central) and 1 (Pacific); best-of-3 first
    // round, best-of-5 division semifinals and finals, best-of-7 conference
    // finals and Calder Cup Finals. Matches the 2026 bracket feed.
    // 2027: not published yet (2026-27 realigned to Atlantic 7 / North 8,
    // so the per-division counts can't be carried over).
    2026: {
      label: '2026 Calder Cup Playoffs',
      bestOf: [3, 5, 5, 7, 7],
      firstRound: 'First Round',
      qualify: {
        Atlantic: { teams: 6, byes: 2 },
        North:    { teams: 5, byes: 3 },
        Central:  { teams: 5, byes: 3 },
        Pacific:  { teams: 7, byes: 1 },
      },
      source: 'https://theahl.com/qualification-rules',
    },
  },
  echl: {
    // Top 4 of each division, 1 v 4 and 2 v 3 within the division for two
    // rounds, then conference finals and the Kelly Cup Finals, every round
    // best-of-7: ECHL's alignment release (2017-06-20) and the 2026 bracket
    // feed (8 division semifinals, every series to 4 wins).
    2026: {
      label: '2026 Kelly Cup Playoffs',
      bestOf: [7, 7, 7, 7],
      firstRound: 'Division Semifinals',
      perDivision: { teams: 4, byes: 0 },
      source: 'https://echl.com/2026-kelly-cup-playoffs',
    },
    // Same four divisions in 2026-27 (echl.com 2026-27 schedule release:
    // North, South, Central, Mountain); the ECHL hasn't restated the
    // format for 2027 on its own site, the 2017 rule stands unchanged.
    2027: {
      label: '2027 Kelly Cup Playoffs',
      bestOf: [7, 7, 7, 7],
      firstRound: 'Division Semifinals',
      perDivision: { teams: 4, byes: 0 },
      source: 'https://echl.com/news/2026/05/echl-releases-2026-27-schedule',
    },
  },
};

export function playoffFormat(league, year) {
  return PLAYOFF_FORMATS[league]?.[year] ?? null;
}

// "Atlantic Division" / "North" -> "Atlantic" / "North".
export function divisionKey(name) {
  return String(name || '').replace(/\s+Division$/i, '').trim();
}

const teamIdOf = v => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// statviewfeed view=teams (groupTeamsBy=division), already un-JSONP'd ->
// [{ division, teams: [{ teamId, rank, gp, points, pct }] }] in the feed's
// order. Rows without a team id are dropped.
export function parseDivisionStandings(raw) {
  const sections = Array.isArray(raw) ? raw[0]?.sections : raw?.sections;
  return (sections || []).map(s => {
    const h = s.headers || {};
    const title = h.name?.properties?.title || h.team_code?.properties?.title || s.title || '';
    const teams = (s.data || []).map((d, i) => ({
      teamId: teamIdOf(d.prop?.team_code?.teamLink ?? d.prop?.name?.teamLink),
      rank: Number(d.row?.rank) || i + 1,
      gp: Number(d.row?.games_played) || 0,
      points: Number(d.row?.points) || 0,
      pct: d.row?.percentage != null ? Number(d.row.percentage) : null,
    })).filter(t => t.teamId);
    return { division: divisionKey(title), teams };
  }).filter(d => d.teams.length);
}

// { teamId: { seed, division } } from parseDivisionStandings().
export function divisionSeeds(divisions) {
  const out = {};
  for (const d of divisions || []) {
    for (const t of d.teams) out[t.teamId] = { seed: t.rank, division: d.division };
  }
  return out;
}

// "Atlantic Division First Round" -> "First Round", "Pacific Division
// Semifinals" -> "Division Semifinals", "Eastern Conference Finals" ->
// "Conference Finals", "2026 Calder Cup Finals" -> "Calder Cup Finals".
export function roundNameFromSeries(seriesName) {
  const s = String(seriesName || '').replace(/^\d{4}\s+/, '').trim();
  const m = s.match(/^.+?\s+(Division|Conference)\s+(.+)$/i);
  if (!m) return s;
  return /^first round$/i.test(m[2]) ? 'First Round' : `${m[1]} ${m[2]}`;
}

// A HockeyTech game status: '1' not started, '2' in progress, '3'
// unofficial final, '4' final.
const gameStarted = g => ['2', '3', '4'].includes(String(g.status));
const gameFinal = g => ['3', '4'].includes(String(g.status));

function seriesGame(g) {
  const played = gameStarted(g);
  return {
    gameId: teamIdOf(g.game_id),
    date: g.GameDateISO8601 || g.date_time || null,
    home: teamIdOf(g.home_team),
    away: teamIdOf(g.visiting_team),
    homeScore: played ? Number(g.home_goal_count) : null,
    awayScore: played ? Number(g.visiting_goal_count) : null,
    status: g.game_status || null,
    final: gameFinal(g),
    ifNecessary: g.if_necessary === '1',
  };
}

function winsFromGames(games, teamId) {
  return games.filter(g => g.final && g.homeScore != null && (
    (g.home === teamId && g.homeScore > g.awayScore) || (g.away === teamId && g.awayScore > g.homeScore)
  )).length;
}

// modulekit view=brackets' `Brackets` + seeds + the verified format (or
// null) -> { format, rounds: [{ name, bestOf, series: [{ id, name, top,
// bottom, status, winnerTeamId, games }] }] }. `top` is the feed's team1
// (the higher seed in every probed series). A series is final when one
// side reached the round's wins (from the format), reached 4 wins (no
// series is longer than best-of-7), or plays in a later round; live once
// a game has started; else scheduled.
export function buildFeedBracket(brackets, { seeds = {}, format = null } = {}) {
  const rounds = (brackets?.rounds || []).slice().sort((a, b) => Number(a.round) - Number(b.round));
  const laterTeams = rounds.map((_, i) => new Set(
    rounds.slice(i + 1).flatMap(r => (r.matchups || []).flatMap(m => [teamIdOf(m.team1), teamIdOf(m.team2)])).filter(Boolean)
  ));

  return {
    format: format ? { label: format.label, bestOf: format.bestOf, source: format.source } : null,
    rounds: rounds.map((r, i) => {
      const bestOf = format?.bestOf?.[i] ?? null;
      const toWin = bestOf ? Math.ceil(bestOf / 2) : null;
      const series = (r.matchups || []).map(m => {
        const games = (m.games || []).map(seriesGame);
        const side = (id, feedWins) => {
          const teamId = teamIdOf(id);
          const wins = typeof feedWins === 'number' ? feedWins : (teamId ? winsFromGames(games, teamId) : 0);
          return { teamId, seed: teamId ? (seeds[teamId]?.seed ?? null) : null, wins };
        };
        const top = side(m.team1, m.team1_wins);
        const bottom = side(m.team2, m.team2_wins);
        const winner = teamIdOf(m.winner)
          ?? [top, bottom].find(s => s.teamId && ((toWin && s.wins >= toWin) || s.wins >= 4 || laterTeams[i].has(s.teamId)))?.teamId
          ?? null;
        const status = winner ? 'final'
          : (games.some(gameStarted) || top.wins + bottom.wins > 0) ? 'live'
          : 'scheduled';
        return { id: m.series_letter, name: m.series_name || null, top, bottom, status, winnerTeamId: winner, games };
      });
      return { name: (r.round_name || '').trim() || roundNameFromSeries(r.matchups?.[0]?.series_name), bestOf, series };
    }),
  };
}

// "If the playoffs started today": division standings + a verified format
// -> { format, rounds: [{ name, bestOf, series }], byes }. Per division,
// the top `teams` qualify, the top `byes` skip the first round, and the
// rest meet highest vs lowest (ECHL 1v4, 2v3; AHL 2026 Pacific 2v7, 3v6,
// 4v5). Seeds and matchups only: every series is `scheduled` at 0-0.
// Null when there's no format or a division in the standings has no rule.
export function buildProjectedBracket(divisions, format) {
  if (!format) return null;
  const series = [], byes = [];
  for (const d of divisions || []) {
    const rule = format.perDivision || format.qualify?.[d.division];
    if (!rule) return null;
    const qualified = d.teams.slice(0, rule.teams);
    for (const t of qualified.slice(0, rule.byes)) byes.push({ teamId: t.teamId, seed: t.rank, division: d.division });
    const rest = qualified.slice(rule.byes);
    for (let i = 0; i < Math.floor(rest.length / 2); i++) {
      const hi = rest[i], lo = rest[rest.length - 1 - i];
      series.push({
        id: `${d.division}-${hi.rank}v${lo.rank}`,
        name: `${d.division} ${format.firstRound}`,
        division: d.division,
        top: { teamId: hi.teamId, seed: hi.rank, wins: 0 },
        bottom: { teamId: lo.teamId, seed: lo.rank, wins: 0 },
        status: 'scheduled',
      });
    }
  }
  return {
    format: { label: format.label, bestOf: format.bestOf, source: format.source },
    rounds: [{ name: format.firstRound, bestOf: format.bestOf[0], series }],
    byes,
  };
}
