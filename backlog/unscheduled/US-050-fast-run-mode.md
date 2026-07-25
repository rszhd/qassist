# US-050 — A fast, cheap mode for tests that already pass

**As** someone running forty tests nightly of which thirty-nine pass, **I want**
a mode that trades reasoning depth for speed and tokens, **so that** the routine
suite is cheap and only the interesting runs cost real money.

- **Status:** 📋 Planned.
- **Priority:** P3 among the unscheduled work. Small, and it is worth much more
  once US-046 makes the spend visible enough for anyone to care.
- **Estimate:** ~2 h plus the benchmarking, which is most of the work.
- **Depends on:** US-046 (without cost numbers there is no way to say whether
  this helped).

## Why now

`Agent.__init__` exposes several knobs we leave at their defaults, all of which
trade thoroughness for speed and tokens:

| Knob | Default | Effect |
|---|---|---|
| `flash_mode` | `False` | a leaner, faster agent loop |
| `use_thinking` | `True` | the `thinking` field we currently surface per step |
| `max_actions_per_step` | `5` | more actions per LLM round trip = fewer round trips |
| `enable_planning` | `True` | the planner and its replan-on-stall behaviour |
| `use_vision` / `vision_detail_level` | `True` / `auto` | screenshots are the expensive part of every prompt |
| `max_history_items`, `message_compaction` | — | how much context is carried forward |

A nightly regression suite and an exploratory first run of a new goal want
opposite settings, and today they get identical ones.

## Details

- One user-facing choice — **thorough** (today's defaults) vs **fast** — not six
  checkboxes. The knobs are an implementation detail of the two profiles.
  Selectable per test and overridable per run; the default must remain today's
  behaviour.
- **`use_thinking=False` has a visible cost**: `on_step` emits
  `agent_output.thinking` into the step feed and the report. Fast mode makes the
  activity list thinner, which is a product decision, not a silent optimization —
  say so in the UI.
- **`use_vision=False` is the big lever and probably a step too far.** It removes
  screenshots from the prompt, which is most of the token weight, but this is a
  *visual* testing tool and the judge (US-041) grades on screenshots. If vision
  is touched at all, `vision_detail_level='low'` is the honest middle.
- **The deliverable is the measurement, not the flag.** Setting these takes
  minutes; knowing whether fast mode still catches the regressions is the work.
  Run the fixture suite both ways and record duration, steps, cost and — the one
  that decides it — **verdict agreement**. A mode that is 40% cheaper and wrong
  one run in ten is not cheaper, it is a suite nobody trusts.

## Acceptance criteria

- [ ] A test can be marked fast or thorough; thorough is the default and is
      byte-for-byte today's behaviour
- [ ] A run records which mode produced it, so History rows are comparable
- [ ] Where fast mode reduces what the report can show (no thinking), the UI says
      so rather than rendering an empty section
- [ ] Measured over the fixture suite, both modes: duration, steps, cost and
      verdict agreement — recorded in this file, with a stated recommendation on
      whether fast mode is fit for scheduled suites
