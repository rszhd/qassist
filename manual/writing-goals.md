# Writing a goal

A goal is the whole test. It tells the agent what to do, and it is what the
judge checks at the end. A vague goal may therefore pass while proving the
wrong thing.

## The one rule: describe the outcome, not the clicks

The judge can only check what the goal claims. A goal that describes only an
action gives it no outcome to verify, so the run may succeed once the action is
performed, regardless of what it produced.

::: danger Describes clicking
Click the blue Add to cart button
:::

That passes when the button was clicked and the page threw a 500.

::: tip Describes an outcome
Add the first search result for "laptop" to the cart, and confirm the cart
shows one item
:::

That fails when the cart is empty, which is the thing you wanted to know.

The test is easy to apply to your own writing: **could this goal be true while
the feature is broken?** If yes, you have written the steps rather than the
result.

## Say how to get there, but loosely

The agent navigates; it does not guess your information architecture. Naming the
route is fine and usually necessary — what you avoid is naming the *elements*.

```
Go to the pricing page, start a Pro checkout, and confirm the summary
shows the Pro plan at the yearly price
```

That is a route ("pricing page", "Pro checkout") and an outcome ("summary shows
… yearly price"). It carries no selector, no button colour and no DOM position,
so it survives a redesign — which is the point of writing tests this way at all.

## One goal, one thing

A goal with four unrelated checks fails as a unit and tells you very little:
something among the four did not happen. Four focused goals fail individually
and name the broken behavior.

The natural size is *one user-visible outcome and whatever navigation it takes
to reach it*. When a goal starts needing "and then", it is usually two tests —
or a [suite](./organizing.md), which is exactly the tool for "these four things
must all be true".

## Be specific about the values

The agent reads the page; it does not know your data. "Confirm the total is
right" is not checkable. "Confirm the total is $49.00" is.

Where the value changes per environment — a user, a base URL, a coupon code —
do not clone the test per environment. Declare it as a
[variable](./variables.md) and let each run supply it:

```
Log in as {{user}} and confirm the dashboard greets them by name
```

## What the agent cannot be asked to do

Some of these are limits of the approach and some are deliberate fences. Either
way, no wording gets around them:

- **Read your email, unless you have set that up.** A goal that needs a
  confirmation code needs the [mailbox to be reachable](./saved-sessions.md).
- **Solve a CAPTCHA.** Nothing in the product tries, and a goal that runs into
  one fails there.
- **Visit an address the instance blocks.** Private and loopback addresses are
  refused by default, and a project can narrow that further — see
  [Where a run may go](./navigation-fence.md).
- **Do anything with a file it was not given.** A run may attach only its own
  project's [files](./files.md), by filename.
- **Run forever.** A run is bounded by a step ceiling and a wall clock, both
  [instance settings](./settings.md). A goal that needs forty steps on a good
  day is a goal that needs splitting.

## Two more things worth knowing

**A goal that logs in every time is mostly testing your login form.** If every
test in a project starts by signing in, that is twenty runs a night proving the
same thing and paying for it in steps. Capture the signed-in state once instead:
[Behind your login](./saved-sessions.md).

**A cookie banner is two wasted steps on every run, forever.** It is not part of
what you are testing, so it should not be part of the goal. A project can dismiss
it before the agent's first step, at no token cost —
[a preamble](./organizing.md#a-preamble-before-the-first-step).
