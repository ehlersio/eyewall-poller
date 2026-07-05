# eyewall-poller

Cloudflare Workers backend for EyeWall Analytics — a hockey analytics platform covering NHL (Carolina Hurricanes focus) and PWHL. Polls live game data, serves API endpoints to the frontend, sends push notifications.

## Stack
- Cloudflare Workers, Wrangler 4
- KV for caching
- Supabase (via HTTP, not a native client) for persistent data
- Vitest for tests (plain Node — not `@cloudflare/vitest-pool-workers`; this codebase's logic mocks `fetch`/KV cleanly without needing a real Workers runtime)
- ESLint 9 (pinned — do not upgrade to 10 without checking peer deps on `eslint-plugin-react`/`eslint-plugin-react-hooks`)

## Sibling repos
Lives in `eyewall/` alongside `eyewall-pipeline` (Python data pipeline) and `eyewall-analytics` (React frontend). This repo is the API layer between them — the pipeline writes to Supabase, this Worker reads from Supabase + live APIs and serves the frontend.

## Live season resolution (core architecture, built Session 35–36)

`seasons.js` is the single source of truth for "what season is it right now" — replaced ~8 independently hardcoded season constants across all three repos.

- `resolveNHLSeason(env)` — calls `api-web.nhle.com/v1/standings/now`, rejects the candidate if `gamesPlayed` is 0, falls back to a hardcoded seed otherwise. Cached in KV (`config:season:nhl`, 6hr TTL).
- `resolvePWHLSeason(env)` — calls HockeyTech's `bootstrap` view (`feed=statviewfeed`, **not** `feed=modulekit` — that returns a fake-looking 200 OK with no real payload, a real bug that shipped once). Rejects `current_season_id` if `hide_in_standings: true`, and **prefers the most recent regular season over the most recent season of any type** — a first version of this picked the most recent non-hidden season regardless of type, which resolved to a playoffs season_id and silently broke every downstream query filtering `season_type=eq.regular` (empty results, not sparse — total silent failure across standings/players/team/shot-map views). This is now covered by regression tests built from real production payloads.
- Both exposed via `GET /config/seasons`. Consumed by `eyewall-analytics`'s `seasonClient.js` and `eyewall-pipeline`'s `season_lookup.py`.
- Manual override escape hatch: `config:season:nhl:override` / `config:season:pwhl:override` KV keys, for if live resolution ever misjudges the real Sept/Oct season boundary — **that transition has never actually been observed by this logic yet.** Everything validated so far is the offseason case only.
- `scheduled()` calls both resolvers every ~60s alongside `poll()`/`pollPWHL()` — cheap no-op except right after the 6hr TTL lapses, since both check cache first.

**Known gap:** `pwhl_pbp_events.py` (lives in `eyewall-pipeline`) was not part of the Session 36 wiring — likely still reads `PWHL_SEASON` directly rather than through `season_lookup.py`. Check this before assuming it picks up the live-resolved season.

## PWHL team IDs
HockeyTech IDs, including 2026-27 expansion teams: DET=10, HAM=11, LV=12, SJS=13. Enumerated in `PWHL_TEAM_CODES` here — **this same map is independently duplicated in `pwhl_stats.py` and `pwhl_salaries.py` (eyewall-pipeline) and `pwhlConfig.js` (eyewall-analytics).** A future expansion wave needs all four touched — confirm via grep, don't assume.

## Hard-won lessons (don't relearn these)
- **`wrangler kv` needs `--remote`** to operate on the namespace the deployed Worker actually reads. Without it, commands silently hit the local/preview namespace.
- **Cache-busting order matters.** Bust KV cache only *after* confirming the underlying data fix has actually landed — busting first just repopulates the same stale/empty entry.
- **Don't reconstruct HockeyTech URLs from written notes/descriptions.** Pull the real request from DevTools. Both real production bugs in the season-resolution work traced back to a URL built from memory/notes rather than a captured request.
- If touching roster/season logic: `fetch_roster()`-style calls need the **literal current/preseason season ID**, not the "most recent regular season" that `resolvePWHLSeason()` deliberately prefers. These two concepts intentionally disagree — don't conflate them.

## Testing
Run the full Vitest suite before pushing. `src/__tests__/seasons.test.js` has regression coverage for both real bugs above — if touching `seasons.js`, make sure these still pass and add a new regression test for any new edge case found.

## Deploy
GitHub Actions auto-deploy on push via Wrangler. Dependabot is active — watch for major-version bumps (ESLint 9→10, others) that need manual verification before merging; comment `@dependabot ignore this major version` on ones deferred to October.
