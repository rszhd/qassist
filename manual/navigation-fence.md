# Where a run may go

A run is a real browser pointed at user-supplied URLs, so its navigation needs
an explicit boundary. QAssist applies two layers: an instance-wide floor and an
optional allowlist per project.

## The instance floor

By default an instance **refuses private and loopback addresses**, and refuses
bare IP addresses. On a shared instance that matters: without it, "point the
tester at a URL" quietly becomes "read the host's cloud metadata endpoint".

An instance can also carry a denylist of hosts.

If your entire use case is testing `http://localhost:3000` on your own machine,
that floor is [one setting](./settings.md) and turning it off clears the host
denylist with it.

## A project allowlist

A project can narrow things much further: *these tests may visit our staging
host and nothing else.*

```
allowed domains:  *.staging.example.com
```

`*.example.com` matches the apex as well as its subdomains. An empty list means
no allowlist — the instance floor alone.

This is worth setting on any project whose tests carry [secrets](./variables.md)
or start from a [saved session](./saved-sessions.md), because it is what bounds
where a credential can be carried.

::: warning An allowlist cannot open a hole in the floor
An allowlist that would defeat the instance's own denylist is refused when you
try to save it, naming the host. A per-project allowlist otherwise takes
precedence inside the browser, so this is the check that keeps the floor a floor.
:::

## Fenced twice, so a redirect cannot slip past

The check is not only at the start:

1. **The start URL is judged before anything is enqueued.** A blocked URL is
   refused immediately with a reason, and no run row is written.
2. **The same policy arms the browser**, so a **redirect** into a blocked host
   mid-run is stopped where it happens. The run ends failed with
   `navigation_blocked` and a named section in the report — it does not wander
   off and blame the instructions.

## The reasons a URL is refused

A refusal carries a machine-readable reason, so a pipeline can branch on it
without reading prose:

| Reason | |
|---|---|
| `blocked_ip_address` | An IP address, or a private/loopback one, and the instance does not visit those. |
| `blocked_host` | On the instance's denylist. |
| `not_in_allowed_domains` | The project has an allowlist and this is not on it. |
| `unsupported_scheme` | Not `http` or `https`. |
| `invalid_url` | Not a URL. |

## One blocked test does not cost a batch its results

When a [module, suite or project](./organizing.md) runs, a blocked member is
reported inside the response as blocked, with its reason, and **the rest of the
batch still runs**. One test pointed at localhost does not take twelve other
verdicts with it.

## The preamble is checked too

A project's [initial actions](./organizing.md#a-preamble-before-the-first-step)
can navigate, and that URL goes through the same fence — but at the moment you
**save** it, not at run time. A preamble that would be blocked is refused while
you are looking at it.
