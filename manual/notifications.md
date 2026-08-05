# Email notifications

QAssist can mail you when a run finishes, with the [PDF
report](./reading-a-verdict.md#the-pdf-report) attached where the instance
renders one.

## Turning it on

Notifications need a mail sender configured on the instance. Without one the
preferences below still save and nothing sends — the instance's health endpoint
is what tells you which of the two you are looking at. On a hosted account this
is already done.

## Who hears about what

Preferences live on the **project**, so one recipient list covers every test in
it. Open the project's settings and set:

- **Recipients** — the addresses to mail.
- **When** — one of three:

| Mode | Mails on |
|---|---|
| **failure** (default) | Failed, errored, or unjudged runs. A run stopped by hand is not treated as a failure. |
| **always** | Every finished run. |
| **never** | Nothing. |

Each finished run decides for itself, and each recipient gets one message.

**An ad-hoc run never mails.** It has no saved test and therefore no project, so
there is no notification preference to read. A saved test launched from the Run
view still follows its project's preference.

An empty recipient list on a project falls back to the instance's default list,
and then to the operator's address. A self-hosted instance can therefore set one
fallback address without repeating it on every project; the project's delivery
mode still decides which runs produce mail.

## Unsubscribing

Every mail carries an unsubscribe link. It is the one address in the whole app
that needs no token — the person clicking it was sent a report and does not have
your instance's credentials.

**Suppression is by address and instance-wide.** Being added to a second
project's recipient list cannot quietly re-subscribe someone who opted out. If
somebody unsubscribed by accident, an operator can put them back.
