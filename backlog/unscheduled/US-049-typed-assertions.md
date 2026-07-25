# US-049 — Assert on a value, not on a paragraph

**As** someone writing a regression test, **I want** to assert that the order
total is exactly `$49.99`, **so that** the verdict rests on a value read off the
page rather than on a model's opinion that things looked fine.

- **Status:** 📋 Planned. **Correctness-critical if built** — it defines what
  "pass" means; owes a row in
  [`correctness-critical.md`](../correctness-critical.md).
- **Priority:** P3 among the unscheduled work. Deliberately *after* US-041: the
  cheap 80% of this is ground truth handed to the judge, and it would be
  embarrassing to build a comparison engine and then discover prose criteria
  covered it.
- **Estimate:** ~5 h.
- **Depends on:** US-041 (ground truth is the simpler version of the same idea).

## Why now

Every QAssist verdict is currently a natural-language judgement about a
natural-language goal. That is the right default and it is what makes the
product approachable — but it means the tool cannot express the one thing a
regression suite is for: *this number must not change*.

The mechanisms exist and we use none of them:

- `Agent(output_model_schema=…)` / `extraction_schema=…` — the run's final
  result comes back as a typed object matching a supplied schema, instead of as
  prose.
- The registry's `extract` action (LLM structured extraction from page markdown)
  and, better, `search_page` and `find_elements` — both documented as *"Zero LLM
  cost, instant"*. Grep the page text; query by CSS selector.

The last two matter more than the schema plumbing. A check that costs no tokens
and cannot hallucinate is a categorically better assertion than one that asks a
model to look again.

## Details

- A saved test gains optional **checks**: a small list of `{ selector | pattern,
  expectation }`. Evaluated after the goal completes; all must hold for the run
  to be green. A test with no checks behaves exactly as today — this must be
  additive, and it must stay invisible to someone who just wants to type a
  sentence, in the same way grouping is progressive (`CLAUDE.md`).
- **Prefer deterministic checks.** `find_elements`/`search_page` for anything
  expressible as a selector or a literal; fall back to `extract` only where the
  value genuinely needs reading comprehension. The cost and reliability
  difference is the entire argument for the feature.
- The report should print each check with its expected and actual value. A red
  run then explains itself in one line, with no model in the loop.
- **Resist building a DSL.** `CLAUDE.md` names codegen/DSLs in the avoid list,
  and an assertion language is exactly how one starts. Equality, contains,
  matches, and a number comparison. If that is not enough, the answer is a real
  Playwright test, not a bigger grammar here.

## Assertion-first notes

A check engine is the definition of easy-to-get-subtly-wrong, and every bug in
it is a false green:

- A selector that matches nothing must **fail**, not vacuously pass — the
  classic way an assertion framework silently stops asserting.
- Whitespace, currency symbols, thousands separators and non-breaking spaces:
  `$1,234.00` vs `$1 234.00` vs `$1234`. Whatever normalization is chosen must be
  written down and pinned, because it is the difference between a flaky suite and
  a trusted one.
- Multiple matches for one selector — first, all, or an error? Pick and pin it.
- Interaction with US-041: a check failing while the judge says pass (and the
  reverse) needs a stated precedence, not an accident of ordering.

## Acceptance criteria

- [ ] A saved test can carry checks; a test with none is byte-for-byte today's
      behaviour, and the UI does not show them until a project exists to want them
- [ ] Selector- and text-based checks run without an LLM call
- [ ] A check whose selector matches nothing fails the run and says so
- [ ] Expected vs actual for every check appears in the run detail and the report
- [ ] Precedence between a failed check and a passing judge verdict is defined,
      documented and tested in both directions
- [ ] Normalization rules (whitespace, currency, separators) are pinned by pure
      tests, written and reviewed before the implementation
