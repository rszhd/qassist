# BUG-004: a literal `<secret>` in a saved goal is accepted and silently does nothing

**Status:** 📋 Open
**Reported:** 2026-07-27
**Area:** server (`server/src/variables.js`, `routes/tests.js` write path);
the failure surfaces in the agent

## What happens

A saved test whose goal contains `<secret>name</secret>` written by hand is
accepted at save and fails opaquely at run time. Observed while taking US-043's
AC #6 measurement, with this goal:

```
Log in using the email <secret>shop_email</secret> and the password
<secret>shop_password</secret>. Then open the "My account" page …
```

`shop_email` and `shop_password` were declared as secret variables and had
values. The run failed after 10 steps, with the agent reporting:

> I was unable to log in because only placeholder strings ('<shop_email>' and
> '<shop_password>') were entered into the login form rather than actual
> credentials.

## Why

`<secret>name</secret>` is `resolveForRun`'s **output**, not its input.
`referencedNames` scans for `{{name}}` (`variables.js:22`), finds none, so
`used` is empty, so `secrets` is empty — `QA_VARS` ships as `{}`, browser-use
gets no `sensitive_data` for those keys, and the literal placeholder text
travels into the task unchanged. The agent then types it.

Every layer behaves exactly as designed. The declaration is valid, the goal is
valid, nothing is undefined, and no error is available to raise — which is why
this is a save-time validation gap rather than a runtime bug.

## Why a user writes it

Not a contrived mistake. `<secret>name</secret>` is the spelling US-034 puts in
front of anyone using email confirmation: `run_agent.py` appends task text
telling the agent to "enter `<secret>qa_password</secret>`" and
"`<secret>email_code</secret>`" (`run_agent.py:510-512`). A user who has read a
run's task, or who is combining email confirmation with US-035 variables, has
seen the spelling and can reasonably assume it is theirs to write.

The frontend shows it too, though only as display: `runHelpers.js:29` renders a
secret's substituted form as `<secret>name</secret>` so the value never appears
on screen.

## The fix, and the exception that stops it being one line

Reject a literal `<secret>` in a saved `goal` or `start_url` at write time
(`POST`/`PUT /api/tests`), with a message naming the right spelling:

> use `{{name}}` — `<secret>name</secret>` is the internal form and will be sent
> to the browser literally

**But it cannot be a flat rejection.** Three secret names are added to
`sensitive` by the agent at run time, not by `resolveForRun`: `qa_password`,
`email_code` and `email_link` (`run_agent.py:455, 491, 494`). A goal written by
hand as `enter <secret>email_code</secret>` therefore **works today** — the
agent puts that key in `sensitive` before the step that needs it — and there is
no `{{}}` spelling that reaches them, because `validateReferences` would reject
`{{email_code}}` as undeclared.

So the validation is: refuse a literal `<secret>name</secret>` **unless `name`
is one of the agent-provided three**. Which means the fix owes a decision the
implementer should make deliberately rather than inherit:

- keep the exemption list, and it must live somewhere both the server and
  `run_agent.py` can be checked against, or the two drift and a future
  agent-provided secret is rejected at save;
- or give the three a `{{}}` spelling by pre-declaring them, and refuse the
  literal form outright — tidier, and a bigger change than this ticket.

## Test

`variables.test.js` for the pure check (the reject table, and the three names
that must still be accepted), plus one over HTTP proving the refused write
stores nothing. The existing "a secret cannot appear in start_url" assertion is
the neighbour to put it beside.
