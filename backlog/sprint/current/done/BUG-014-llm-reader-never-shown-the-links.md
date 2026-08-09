# BUG-014 — The LLM reader is never shown the email's links, and answers "none"

- **Status:** ✅ Fixed 2026-08-10 — found in staging run
  `6984279c-e14a-4664-b287-7fc4b4920058` (2026-08-09), the first run on the
  image carrying [US-080](US-080-llm-email-code-extraction.md).
  On `dev`; the real-model, real-mailbox evidence US-080 was waiting for is
  the *next* staging registration run.
- **Relative to US-080:** not a flaw in its contract. The reader's answer
  being final is what makes it worth having, and this is what that contract
  costs when the reader is fed less than the fallback it silences.
- **Lives in:** `agent/email_extract.py` (`build_prompt`) +
  `agent/email_codes.py` (`link_candidates`)
- **Severity:** total loss of the registration flow, not a degraded one. The
  reader reports "no code and no link" for every HTML email whose URL is only
  in an `href` — which is every transactional email with a button in it — and
  by US-080's own contract that answer is **final**, so `extract_link` never
  runs. The regression is silent in the log: the action reports the
  diagnosable outcome it was designed to report, and it is wrong.

## What happens

`build_prompt` sends the model the subject and `body_text`. It never sends
`body_html`.

The tested site's first registration email is a link and nothing else. Its
`body_text` — the same fixture BUG-012 cut from the real message — reads:

```
Please verify your email address by clicking the verification link below.
Verify my account
```

"Verify my account" is the anchor text. The URL is only in the `href`, and
`_strip_html` drops attributes, so no rendering of that email into text can
carry it. The model was shown an email that says "click the link below" with
no link below it, and answered `{"code": null, "link": null}` — honestly, for
what it could see.

`_extract` then did exactly what US-080 specifies: a tuple is the reader's
final word, so the regex pair stayed silent. `extract_link` reads `href`
attributes and had answered this same email correctly in every run before.

In staging run 6984279c the agent got neither artifact, declined to guess (as
instructed), tried to log in, was refused because the account was never
activated, and reported failure after 35 steps.

## Why it survived 35 assertions

Every case in `TestMakeExtractor` passes `html=""`. `TestValidateLink` hands
`validate()` a link directly, so it exercises the cage and never the prompt.
The one prompt assertion,
`test_the_body_reaches_the_prompt_and_the_stated_width_is_mentioned`, uses the
OTP body — which has no link in it.

So the suite measured what the reader is allowed to *return* and never what it
is *shown*. Between those two sets, US-080 opened a gap in the direction that
loses information: the cage validates against `link_candidates`, which reads
hrefs, while the prompt was built from stripped text alone.

The lesson is BUG-012's, one layer up. There, no fixture had a digit run that
was not the code, so the fallback's appetite was never measured. Here, no
fixture had a link that was not in the text, so the prompt's blind spot was
never measured. **A test that stubs the model measures validation; only a test
that captures the prompt measures perception.**

## Fix (assertion-first — register row 57; ten assertions red first)

1. **New `email_codes.labelled_links(body_text, body_html)`** — the URLs of
   `link_candidates`, in the same order, deduplicated, each paired with its
   anchor text. One list feeds both the prompt and the validation, so a URL
   can never be unreachable in one and acceptable in the other.
2. **`build_prompt` takes `body_html` and lists those pairs** after the
   truncated body, so `BODY_LIMIT` can never be what hides them. The system
   prompt tells the reader the list is every URL the email has, that the body
   names its links without spelling them out, and to prefer the
   confirm/verify/activate link over an unsubscribe or marketing one.

The label carries the whole judgement: as bare URLs, an activation link and an
unsubscribe link are two opaque strings, and choosing between them is the
reason this reader exists.

## Guarded by

`agent/tests/test_email_extract.py` (`TestTheReaderSeesEveryLink`) and
`agent/tests/test_email_codes.py` (`TestLabelledLinks`). Ten of the twelve new
assertions were red before the fix. The anchor-text one needed sharpening to
get there: this email says "Verify my account" in its body as well, so the
first version — which looked for the words anywhere in the prompt — passed
without the pairing existing, the same trap BUG-012's window test fell into.
It now asserts the label sits on the URL's own line, and that a second link's
label does not.

The two that were green pre-fix are kept as documentation, and the story file
says which: the cage always accepted a link it was shown, and an email with no
URLs always offered none.

## Also fixed here

The `RuntimeError('Event loop is closed')` traceback in the same run's log, at
the same step. `asyncio.run` closes the loop, and `ChatOpenAI.ainvoke` builds
an `AsyncOpenAI` per call that nobody closes, so httpx tears its pool down
afterwards on a dead loop. `run_agent.extractor_invoke` now owns the
`httpx.AsyncClient` and closes it inside the loop it belongs to. It was noise
in this run — the call had returned — but it leaked a connection pool per
email read, and it is the first thing anyone reading that log would chase.
