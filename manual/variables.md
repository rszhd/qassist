# Variables and secrets

A variable is a named value the instructions and the start URL can reference,
so that one saved test covers every environment instead of being cloned per
environment.

## Declaring one

A test declares its variables by name. A plain variable may have a default, and
any variable may be marked **Optional**. The instructions and URL reference them with
double braces:

```
Name       admin login
Start URL  https://{{env}}.example.com/login
Instructions Log in as {{user}} with {{pw}} and confirm the dashboard loads
Variables  env  = staging
           user = admin
           pw   = ●●●●●●  (secret)
```

Run it and each variable can be overridden for that run alone. Nothing about the
saved test changes.

## Where a value comes from

At run time, QAssist resolves each variable in this order:

1. **The override** given for this run — typed in the run dialog, or sent by
   [CI](./ci.md).
2. **A value stored on the test** for a secret variable.
3. **The saved default** for a plain variable.

By default, a referenced variable is required. If nothing resolves it, the run
is refused with an error naming the variable instead of starting with a hole in
the instructions. Mark it **Optional** only when an empty value is meaningful; QAssist
then substitutes an empty string.

::: warning An empty override never displaces a stored secret
Blank means "I didn't type one", not "run without it". This matters most in a
pipeline: a `""` for a password falls back to the stored value rather than
running signed out.
:::

## Secrets

Tick **Secret** on a variable and its value is stored encrypted and is **never
returned by the app or API**. A read tells you only whether a value is set.

It reaches the browser through the agent's sensitive-data channel. QAssist
scrubs it from structured output, including:

- the run's instructions, as stored or as shown,
- the history row,
- the step list or the diagnostics,
- the PDF report or the notification email.

Screenshots and recordings are pixels, not structured text. Password fields
normally mask their contents, but QAssist cannot redact a page that deliberately
renders the secret visibly.

### The three-state box

Because you can never read a secret back, a blank field needs a safe meaning
when you edit a test:

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

Without variables, teams often clone a test per environment, then let the copies
drift. Variables keep one definition and let each pipeline provide the values
that differ:

```jsonc
// the production pipeline
{"variables": {"env": "prod", "user": "ci-bot"}}

// the staging one — same test, same job, two strings changed
{"variables": {"env": "staging", "user": "staging-bot"}}
```

When a module, suite, or project runs, its overrides are offered to **every**
member test. Each test uses the names it declares and ignores the rest. One
batch payload can therefore serve tests with different variable sets.

## Schedules and secrets

A [schedule](./schedules.md) has nobody to ask for a password at 2am, so it uses
the value stored on the test. That is why storing a secret on the test is worth
doing even when your pipeline injects its own.

A schedule is **refused at the moment you save it** if any test it targets needs
a secret it has not got, naming the test and the variable — rather than firing
into a 400 every night while nobody is watching. The exception is turning a
schedule *off*, which is always allowed: refusing that edit would put the fix
behind the refusal.
