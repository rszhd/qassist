# Variables and secrets

A variable is a named value the goal and the start URL can reference, so that
one saved test covers every environment instead of being cloned per
environment.

## Declaring one

A test declares its variables by name, optionally with a default. The goal and
the URL reference them with double braces:

```
Name       admin login
Start URL  https://{{env}}.example.com/login
Goal       Log in as {{user}} with {{pw}} and confirm the dashboard loads
Variables  env  = staging
           user = admin
           pw   = ●●●●●●  (secret)
```

Run it and each variable can be overridden for that run alone. Nothing about the
saved test changes.

## Where a value comes from

At run time, three sources, in this order:

1. **The override** given for this run — typed in the run dialog, or sent by
   [CI](./ci.md).
2. **The value stored on the test** (this is where a secret's value lives).
3. **The declared default.**

A variable that a goal references, has no default, and gets no override is
**required**. A run that would leave a hole in the goal is refused with an error
naming the variable, rather than run with a blank in it.

::: warning An empty override never displaces a stored secret
Blank means "I didn't type one", not "run without it". This matters most in a
pipeline: a `""` for a password falls back to the stored value rather than
running signed out.
:::

## Secrets

Tick **secret** on a variable and its value is stored encrypted and is **never
returned by anything**. Not by the app, not by the API, not to you. What a read
tells you is whether a value is set, and nothing more.

It reaches the browser as sensitive data, so it never appears in:

- the run's goal, as stored or as shown,
- the history row,
- the step list or the diagnostics,
- the PDF report or the notification email.

### The three-state box

Because you can never read a secret back, editing a test needs blank to mean
something safe. So:

| What you do to the box | What happens |
|---|---|
| **Leave it blank** | Keeps what is stored. |
| **Type a new value** | Replaces it. |
| **Clear it explicitly** | Removes the stored value. |

Blank has to mean *keep*, because anything that reads a test and writes it back
is sending back a value it was never allowed to read. Removing the variable
altogether, or unticking **secret**, deletes the stored value with it.

::: danger The one place a secret can still leak
A secret that your app puts in a **URL query string** appears verbatim in an
opt-in [HAR capture](./reading-a-verdict.md#when-the-summary-is-not-enough).
Chromium writes that file, not QAssist, so the redaction that covers everything
else does not reach it. It is off by default for exactly this reason.
:::

## Why this beats cloning the test

The alternative to variables is one saved test per environment, which means the
same goal written four times and drifting three ways. With variables there is
one test and one pipeline snippet, and a staging job is the production job with
different values:

```jsonc
// the production pipeline
{"variables": {"env": "prod", "user": "ci-bot"}}

// the staging one — same test, same job, two strings changed
{"variables": {"env": "staging", "user": "staging-bot"}}
```

When a batch runs — a module, a suite, a project — the overrides are sprayed
across **every** test in it. Each test substitutes the names it declares and
fills the rest from its own defaults, so a name a given test does not declare is
simply ignored. You do not have to know which member wants which variable.

## Schedules and secrets

A [schedule](./schedules.md) has nobody to ask for a password at 2am, so it uses
the value stored on the test. That is why storing a secret on the test is worth
doing even when your pipeline injects its own.

A schedule is **refused at the moment you save it** if any test it targets needs
a secret it has not got, naming the test and the variable — rather than firing
into a 400 every night while nobody is watching. The exception is turning a
schedule *off*, which is always allowed: refusing that edit would put the fix
behind the refusal.
