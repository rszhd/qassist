# US-045 — Bring your own key, to your own provider

**As a** self-hoster, **I want** to point QAssist at the model provider I
already pay for — or at one running on my own machine — **so that** "self-host"
does not mean "and send every screenshot of your product to OpenAI".

- **Status:** 📋 Planned.
- **Priority:** P2 among the unscheduled work. The Ollama tier is the
  differentiator; the rest is table stakes.
- **Estimate:** ~4–5 h for provider selection end to end; the local-model tier
  is mostly evaluation, not code.
- **Depends on:** US-005 (stored keys), US-039 (which made BYOK the only funding
  path and therefore made *which* provider the obvious next question).

## Why now

`run_agent.py` hardcodes `ChatOpenAI(model=…)` reading `OPENAI_API_KEY`.
browser-use 0.13.6 ships fifteen chat backends
(`browser_use/llm/__init__.py:29–43`): `ChatAnthropic`, `ChatGoogle`,
`ChatGroq`, `ChatOllama`, `ChatOpenRouter`, `ChatAzureOpenAI`, `ChatAWSBedrock`,
`ChatAnthropicBedrock`, `ChatDeepSeek`, `ChatMistral`, `ChatCerebras`,
`ChatVercel`, `ChatOCIRaw`, `ChatLiteLLM`, `ChatBrowserUse`. Same `BaseChatModel`
interface; the `Agent` does not care which it gets.

Three reasons this matters more than "nice, more choice":

1. **US-039 made the key the user's.** Having just told every user they must
   bring a key, telling them it must be an OpenAI key is a worse answer than it
   was when the operator was paying.
2. **Ollama is a genuine product claim.** Fully local: the agent, the browser,
   the model, the artifacts, none of it leaves the box. No competitor in this
   space can say that, and for anyone testing a pre-release product or working
   under a data-residency rule it is the *only* acceptable answer. It is also
   the natural pairing with the desktop track (US-016..019) if that is ever
   picked up.
3. **`fallback_llm`** is a free reliability win once more than one backend is
   configured — an `Agent` constructor parameter, no orchestration needed.

## Details

- **Storage.** `users.openai_key_ciphertext` becomes provider-tagged, or gains
  siblings. Prefer widening the existing column with a `provider` alongside it
  over one column per vendor. Whatever the shape, encryption, read-never-returns
  and containment-to-child-env (US-005, US-039) apply unchanged — the assertions
  in `openai-key.test.js` / `openai-key-postgres.test.js` should generalize
  rather than be duplicated per provider.
- **Selection.** Provider + model on the account (with a per-project override if
  it turns out to be wanted; do not build it speculatively). The agent maps
  provider → chat class in one small table.
- **`BROWSER_USE_MODEL` stops being sufficient** as the single knob and needs a
  provider next to it. Keep the old variable working with an OpenAI default so
  no existing `.env` breaks.
- **Not every backend is worth supporting.** Vision quality and structured-output
  reliability vary enormously, and this product depends on both — the judge
  (US-041) sends ten screenshots and demands a typed `JudgementResult`. A model
  that cannot reliably return structured output will produce a *plausible* wrong
  verdict, which is worse than an error. So the deliverable includes a short
  table in the README of what was actually tried, on what, with what result —
  and an explicit "everything else is unsupported, it may well work".
- **Local models specifically** need a measured verdict, not an aspiration. Run
  the same fixture suite against a local vision model and record steps, wall
  clock and verdict agreement here. If a 7B model needs three times the steps
  and gets the verdict wrong a fifth of the time, that is the finding, and it is
  worth writing down either way.

## Acceptance criteria

- [ ] A user can store a key for a provider other than OpenAI and run with it;
      the key is encrypted at rest and never returned on read, exactly as US-005
      requires today
- [ ] An existing `.env` with `OPENAI_API_KEY`-shaped setup and
      `BROWSER_USE_MODEL` keeps working unchanged
- [ ] A run records which provider and model produced it; History and the report
      show it, so two runs of the same test are comparable
- [ ] A run against a local Ollama model completes end to end with no outbound
      network from the container, proven by blocking egress
- [ ] The README carries the tried/known-good table and states plainly that
      other backends are unsupported-but-permitted
- [ ] Measured numbers for the local tier (steps, duration, verdict agreement vs
      the OpenAI baseline over the fixture suite) recorded in this file
