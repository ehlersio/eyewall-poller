-- Odds Persistence Writer -- new nhl_odds table.
-- Run this in the Supabase SQL editor. This repo has no migration tooling
-- -- schema changes are applied directly in Supabase, same convention as
-- eyewall-pipeline's docs/*.sql column-addition references.
--
-- Why: replaces the frontend's per-visitor live Odds API calls (budget risk
-- -- every concurrent visitor independently burned from the shared
-- 500-requests/month key) and a separate, previously-undiscovered dead
-- write in nhl.js's fetchOdds() (wrote to the odds:nhl KV key, which
-- nothing ever read back -- confirmed by grep before removing it in this
-- same change). See ODDS_PERSISTENCE_WRITER_SCOPE.md for the full design.
--
-- Storing home_abbr/away_abbr/commence_time rather than a game_id column:
-- resolving a definitive game_id at write time would need the Worker to
-- fetch a genuinely multi-day, all-32-teams schedule (the existing
-- /score/now scoreboard this fetch reuses for its pregame-proximity check
-- is today-only) -- deferred to read time instead (join against game_log
-- by date + team abbrevs), which is simpler and doesn't add a new
-- multi-day league-wide fetch to the write path.
create table if not exists public.nhl_odds (
  id             bigserial primary key,
  season         integer     not null,
  home_abbr      text        not null,
  away_abbr      text        not null,
  commence_time  timestamptz not null,
  moneyline_home integer,
  moneyline_away integer,
  book           text,
  fetched_at     timestamptz not null default now(),
  unique (season, home_abbr, away_abbr, commence_time)
);

-- RLS: the Worker has only ever READ from Supabase via the anon key
-- (sbRows()) -- it has never written anything before this. Rather than
-- introduce a service-role key into the Worker's environment for the
-- first time ever (broad credential, larger blast radius if it ever
-- leaked), this grants the anon role narrow insert/update/select access
-- scoped to just this one table.
alter table public.nhl_odds enable row level security;

create policy "anon can upsert nhl_odds" on public.nhl_odds
  for insert to anon with check (true);

create policy "anon can update nhl_odds" on public.nhl_odds
  for update to anon using (true) with check (true);

create policy "anon can read nhl_odds" on public.nhl_odds
  for select to anon using (true);
