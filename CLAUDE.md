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

## Git branch hygiene (standing rule — read before any session)

Before making any file changes in a new session, always run:

```
git status
git branch
```

If the current branch is not `main`, or if `main` locally is behind `origin/main`, stop and do this first:

```
git checkout main
git pull origin main
```

Then sweep local branches from prior sessions: for each `sessionNN-*` branch still present locally, confirm on GitHub that its PR merged, then delete the local branch (`git branch -d <branch>`; use `-D` only if it's confirmed merged but not fast-forward-mergeable locally). Remote branches auto-delete on merge in this repo (and the other two EyeWall repos), so this sweep is local-only. Do not delete a branch whose PR hasn't merged, even if it looks stale.

Once `main` is current and stale local branches are cleared, cut a fresh branch for the new session:

```
git checkout -b <new-branch-name-for-this-session>
```

Only start editing files after confirming you're on a fresh branch cut from an up-to-date `main`. Do not assume the working directory is already in the right state, even if the previous session ended with a merge — branch switches are a manual step and are easy to forget.

Name the new branch for what the session is actually doing (e.g. `session43-line-combinations`), not a generic name, so it's identifiable later if it needs recovering.

## README hygiene (standing rule — read before opening any PR)

Before opening a PR, check whether the change affects anything `README.md` documents — setup/install steps, environment variables, available scripts/commands, API routes or endpoints, known limitations, test counts, or architecture description. If yes, update the README in the same PR. Purely internal changes (refactors, bug fixes with no behavior/interface change) don't need a README touch — don't pad PRs with unnecessary doc churn.

## Live season resolution (core architecture, built Session 35–36)

`seasons.js` is the single source of truth for "what season is it right now" — replaced ~8 independently hardcoded season constants across all three repos.

- `resolveNHLSeason(env)` — calls `api-web.nhle.com/v1/standings/now`, rejects the candidate if `gamesPlayed` is 0, falls back to a hardcoded seed otherwise. Cached in KV (`config:season:nhl`, 6hr TTL).
- `resolvePWHLSeason(env)` — calls HockeyTech's `bootstrap` view (`feed=statviewfeed`, **not** `feed=modulekit` — that returns a fake-looking 200 OK with no real payload, a real bug that shipped once). Rejects `current_season_id` if `hide_in_standings: true`, and **prefers the most recent regular season over the most recent season of any type** — a first version of this picked the most recent non-hidden season regardless of type, which resolved to a playoffs season_id and silently broke every downstream query filtering `season_type=eq.regular` (empty results, not sparse — total silent failure across standings/players/team/shot-map views). This is now covered by regression tests built from real production payloads.
- Both exposed via `GET /config/seasons`. Consumed by `eyewall-analytics`'s `seasonClient.js` and `eyewall-pipeline`'s `season_lookup.py`.
- Manual override escape hatch: `config:season:nhl:override` / `config:season:pwhl:override` KV keys, for if live resolution ever misjudges the real Sept/Oct season boundary — **that transition has never actually been observed by this logic yet.** Everything validated so far is the offseason case only.
- `scheduled()` calls both resolvers every ~60s alongside `poll()`/`pollPWHL()` — cheap no-op except right after the 6hr TTL lapses, since both check cache first.

### `getAllPWHLSeasonTypes()` and `GET /config/seasons/pwhl-types` (Session 37)

`resolvePWHLSeason()` only ever answers "what's the current season" — it fetches HockeyTech's full bootstrap `seasons[]` list but collapses it to one chosen season before returning, discarding the rest. `eyewall-pipeline` needed a way to ask "what type is season N" for an *arbitrary* (possibly historical or not-yet-current) season_id, since several pipeline modules were silently defaulting an unrecognized id to `season_type="regular"`.

Rather than duplicate the bootstrap-fetch logic, `fetchPWHLBootstrap(env)` was extracted as a shared, independently-cached step (`config:season:pwhl:bootstrap` KV key, same 6hr TTL) that both `resolvePWHLSeason()` and the new `getAllPWHLSeasonTypes(env)` call — one HockeyTech fetch answers both questions. `getAllPWHLSeasonTypes()` returns the full `{season_id: season_type}` map (or `null` on failure — never a guess), exposed via `GET /config/seasons/pwhl-types`. Python-pipeline-only; the frontend has no use for this and doesn't consume it, so it's a separate route rather than a new field bolted onto `/config/seasons` (which the frontend does depend on the exact shape of, via `seasonClient.js`).

Consumed by `eyewall-pipeline`'s `season_lookup.get_season_type()`.

## PWHL team IDs
HockeyTech IDs, including 2026-27 expansion teams: DET=10, HAM=11, LV=12, SJS=13. Enumerated in `PWHL_TEAM_CODES` here — **this same map is independently duplicated in `pwhl_stats.py` and `pwhl_salaries.py` (eyewall-pipeline) and `pwhlConfig.js` (eyewall-analytics).** A future expansion wave needs all four touched — confirm via grep, don't assume.

## Hard-won lessons (don't relearn these)
- **`wrangler kv` needs `--remote`** to operate on the namespace the deployed Worker actually reads. Without it, commands silently hit the local/preview namespace.
- **Cache-busting order matters.** Bust KV cache only *after* confirming the underlying data fix has actually landed — busting first just repopulates the same stale/empty entry.
- **Don't reconstruct HockeyTech URLs from written notes/descriptions.** Pull the real request from DevTools. Both real production bugs in the season-resolution work traced back to a URL built from memory/notes rather than a captured request.
- If touching roster/season logic: `fetch_roster()`-style calls need the **literal current/preseason season ID**, not the "most recent regular season" that `resolvePWHLSeason()` deliberately prefers. These two concepts intentionally disagree — don't conflate them.

## Testing
Run the full Vitest suite before pushing. `src/__tests__/seasons.test.js` has regression coverage for both real bugs above, plus `getAllPWHLSeasonTypes()` (id->type map shape, its own KV cache key, and that it shares one bootstrap fetch with `resolvePWHLSeason()` rather than doubling the HockeyTech call) — if touching `seasons.js`, make sure these still pass and add a new regression test for any new edge case found.

## Deploy
GitHub Actions auto-deploy on push via Wrangler. Dependabot is active — watch for major-version bumps (ESLint 9→10, others) that need manual verification before merging; comment `@dependabot ignore this major version` on ones deferred to October.
