-- 020_run_cost.sql — US-046: what did that run cost?
--
-- Since US-039 every run is funded by the user's own key, so the tokens it
-- spent and what they were worth are part of the result rather than an internal
-- metric. The per-model breakdown stays in `runs/<id>/report_data.json` — a row
-- answers "what did last night cost", and only the run detail needs to know
-- which of the three or four LLMs a run bills against spent it.
--
-- Inert on the day it lands, like 013 and 019: every existing row reads as "not
-- measured", which is what those runs are. No backfill is correct for them.

-- Tokens. Null means nobody counted — a run from before this shipped, or one
-- that crashed before browser-use built its summary. Zero means a run that
-- called no model at all, which is a different thing and a real outcome.
alter table runs add column if not exists prompt_tokens     int;
alter table runs add column if not exists completion_tokens int;
alter table runs add column if not exists total_tokens      int;

-- The estimate, and the flag that says whether it is one.
--
-- These two columns are the whole point of the story's spike, and dropping
-- either makes the other a liability. browser-use reports a cost of `0.0` when
-- costing was switched off, when the pricing table could not be fetched, and
-- when the model has no published price — and a genuinely free model reports
-- the same. Storing the float alone would put `$0.00` against a run that cost
-- forty cents, which is a plausible number nobody reports, and the History
-- total would then sum an authoritative-looking figure over a set it could only
-- partly price.
--
-- So: `total_cost` is null unless `cost_known`, and every reader is expected to
-- branch on the flag rather than on the number. numeric, not float8 — this is
-- money-shaped, it gets summed across a filter set, and binary floating point
-- has no business accumulating it.
alter table runs add column if not exists total_cost numeric(12, 6);
alter table runs add column if not exists cost_known boolean not null default false;

-- The invariant the two columns exist to hold, written down where it cannot be
-- forgotten by a later writer: an unknown cost carries no number, and a known
-- one carries a number. `not valid` would let existing rows through, but they
-- already satisfy it — cost_known defaults false and total_cost defaults null.
alter table runs add constraint runs_cost_known_has_a_number
  check ((cost_known and total_cost is not null) or (not cost_known and total_cost is null));
