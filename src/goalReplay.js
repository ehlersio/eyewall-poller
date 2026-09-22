// src/goalReplay.js
// GET /nhl/goal-replay/:gameId/:eventId -- one NHL goal's player and puck
// tracking (NHL EDGE), trimmed for the app's goal replay (Video | Tracking).
//
// Each goal in the game center `landing` feed carries a `pptReplayUrl`: the
// data behind NHL.com's goal visualizer -- every skater's and the puck's
// position, 10 samples a second, for ~14 s around the goal, in inches from a
// rink corner. Available for every goal from 2023-24 on (checked 2026-09).
// The URL is read from `landing`, never built from the ids, and the file
// answers 403 unless the request looks like a browser, so this route is
// also what gets it past the browser's CORS wall.
//
// Response (200):
//   { available: true, gameId, eventId, hz: 10, goalFrame, attacksRight,
//     scorerId, teams: { home, away },
//     players: { [trackId]: { playerId, number, team } },
//     frames: [{ puck: [x, y] | null, at: { [trackId]: [x, y] } }] }
// Coordinates are play-by-play feet (x -100..100, y -42.5..42.5), the same
// system LiveEventRink / react-hockey-rink draw in:
//   x = inches_x / 12 - 100,  y = 42.5 - inches_y / 12
// (checked 2026-09 against 40 goals: the tracked puck passes within ~2 ft
// of the play-by-play shot spot). attacksRight: the goal is in the +x net.
// goalFrame: the frame the puck is in the net -- same rules as
// eyewall-pipeline's goal_of_week.goal_frame().
//
// 404 { available: false } when the goal has no replay (yet, or ever:
// pre-2023-24, or the NHL hasn't published it). The app shows the Tracking
// option only after a 200, so there's never a dead control.
//
// Cache: a finished game's replay never changes -> a year. A live game's
// can be rewritten when the game ends (every file of a 2026-09-20 game was
// rewritten in one batch at the final horn) -> 5 minutes. Not available ->
// 60 s, so a replay that appears mid-game shows up within a minute.

import { kvGet, kvPut, json, errorJson } from './shared.js';

const NHL_BASE = 'https://api-web.nhle.com/v1';
const REPLAY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://www.nhl.com/',
};
const FINAL_STATES = new Set(['FINAL', 'OFF']);
export const TTL_FINAL = 365 * 24 * 3600;
export const TTL_LIVE = 300;
export const TTL_MISSING = 60;

// Rink geometry in play-by-play feet
const GOAL_LINE_X = 89;
const NET_HALF_W = 3;
const NET_DEPTH = 40 / 12;
const NET_SLACK = 3;
const GAP_FRAMES = 3;
const GAP_RADIUS = 10;

const round1 = (v) => Math.round(v * 10) / 10;

export function toFeet(o) {
  return [round1(o.x / 12 - 100), round1(42.5 - o.y / 12)];
}

function puckOf(frame) {
  return Object.values(frame.onIce || {}).find(o => !o.playerId && o.x != null) || null;
}

// Which net the goal is in: whichever the puck gets closest to.
export function attacksRight(frames) {
  let right = Infinity, left = Infinity;
  for (const f of frames) {
    const p = puckOf(f);
    if (!p) continue;
    const [x, y] = toFeet(p);
    right = Math.min(right, Math.hypot(x - GOAL_LINE_X, y));
    left = Math.min(left, Math.hypot(x + GOAL_LINE_X, y));
  }
  return right <= left;
}

// First frame with the puck in the net, entered from in front of the goal
// line -- or, when tracking lost the puck on the shot, the frame it turns up
// past the line near the net. Falls back to the closest approach from in
// front. Mirrors goal_of_week.goal_frame() in eyewall-pipeline.
export function goalFrame(frames, right) {
  const dir = right ? 1 : -1;
  let best = null, bestD = Infinity, wasInFront = false, missing = 0;
  for (let i = 0; i < frames.length; i++) {
    const p = puckOf(frames[i]);
    if (!p) { missing += 1; continue; }
    const [x, y] = toFeet(p);
    const depth = x * dir - GOAL_LINE_X; // > 0: past the attacked goal line
    const fromMouth = Math.hypot(depth, y);
    if (wasInFront && depth >= 0) {
      const inNet = Math.abs(y) <= NET_HALF_W + 0.5 && depth <= NET_DEPTH + NET_SLACK;
      if (inNet || (missing >= GAP_FRAMES && fromMouth <= GAP_RADIUS)) return i;
    }
    wasInFront = depth < 0;
    missing = 0;
    if (depth <= 0 && fromMouth < bestD) { best = i; bestD = fromMouth; }
  }
  return best;
}

// Raw tracking frames -> the compact response body (minus ids/teams).
export function compactReplay(frames) {
  const players = {};
  const out = frames.map(f => {
    const at = {};
    let puck = null;
    for (const o of Object.values(f.onIce || {})) {
      if (o.x == null || o.y == null) continue;
      if (!o.playerId) { puck = toFeet(o); continue; }
      const id = String(o.id);
      if (!players[id]) {
        players[id] = { playerId: Number(o.playerId), number: o.sweaterNumber ?? null, team: o.teamAbbrev || null };
      }
      at[id] = toFeet(o);
    }
    return { puck, at };
  });
  const right = attacksRight(frames);
  return { hz: 10, attacksRight: right, goalFrame: goalFrame(frames, right), players, frames: out };
}

function findGoal(landing, eventId) {
  for (const period of landing?.summary?.scoring || []) {
    for (const g of period.goals || []) {
      if (g.eventId === eventId) return g;
    }
  }
  return null;
}

export async function handleGoalReplay(request, env, url) {
  const m = url.pathname.match(/^\/nhl\/goal-replay\/(\d{10})\/(\d{1,5})$/);
  if (!m) return errorJson(400, { error: 'expected /nhl/goal-replay/:gameId/:eventId' });
  const gameId = m[1];
  const eventId = Number(m[2]);
  const key = `nhl:goal-replay:v1:${gameId}:${eventId}`;

  const cached = await kvGet(env, key);
  if (cached) return cached.available ? json(cached) : errorJson(404, cached);

  const missing = async () => {
    const body = { available: false, gameId: Number(gameId), eventId };
    await kvPut(env, key, body, TTL_MISSING);
    return errorJson(404, body);
  };

  let landing;
  try {
    const res = await fetch(`${NHL_BASE}/gamecenter/${gameId}/landing`);
    if (res.status === 404) return missing();
    if (!res.ok) throw new Error(`landing ${res.status}`);
    landing = await res.json();
  } catch (e) {
    return errorJson(502, { error: e.message });
  }

  const goal = findGoal(landing, eventId);
  const replayUrl = goal?.pptReplayUrl;
  // Only ever fetch the NHL's own replay host, whatever the feed says.
  if (!replayUrl || !/^https:\/\/wsr\.nhle\.com\//.test(replayUrl)) return missing();

  let frames;
  try {
    const res = await fetch(replayUrl, { headers: REPLAY_HEADERS });
    if (res.status === 403 || res.status === 404) return missing();
    if (!res.ok) throw new Error(`replay ${res.status}`);
    frames = await res.json();
  } catch (e) {
    return errorJson(502, { error: e.message });
  }
  if (!Array.isArray(frames) || frames.length < 2) return missing();

  const body = {
    available: true,
    gameId: Number(gameId),
    eventId,
    scorerId: goal.playerId ?? null,
    teams: { home: landing.homeTeam?.abbrev ?? null, away: landing.awayTeam?.abbrev ?? null },
    ...compactReplay(frames),
  };
  if (body.goalFrame == null) return missing();
  await kvPut(env, key, body, FINAL_STATES.has(landing.gameState) ? TTL_FINAL : TTL_LIVE);
  return json(body);
}
