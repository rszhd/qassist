"""Render a QA run's data JSON into a polished PDF report.

Usage:  make_report.py <data.json> <out.pdf>

"Verdict Band" design: the whole header IS the verdict — a full-bleed color
field (pine green pass / deep red fail). Below it the cover carries the run's
figures and summary, and the pages after it the instruction in full (when the
band could hold only its opening) and the browser diagnostics.

Reuses the Chromium that browser-use already installed (via Playwright) to
convert an HTML template to PDF — highest fidelity, embeds fonts as data URIs,
fully self-contained.

The data JSON shape is produced by the Express server (see generateReport()):
  { runId, goal, start_url, model, status, success, duration_seconds,
    steps_count, final_result, errors[], failure_reason, blocked_url,
    has_recording, recording_url,
    generated_at,
    assisted, hints: [{ text, elapsed }],
    steps: [{ step, elapsed, next_goal, evaluation, url, screenshot_file }],
    diagnostics: [{ kind, step, count, url?, status?, error?, level?, text? }],
    diagnostics_dropped: n }
`steps` is read for its count only — the per-step log the server still sends
was never rendered by this template and its half of it is gone (2026-08-04).
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys

from report_format import (
    clamp_goal,
    diagnostic_detail,
    diagnostic_label,
    esc,
    fmt_cost,
    fmt_date,
    fmt_duration,
    fmt_occurrences,
    fmt_tokens,
    group_diagnostics,
)

FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

# (family, weight, filename)
FONT_FILES = [
    ("Ubuntu", 400, "ubuntu-400.woff2"),
    ("Ubuntu", 700, "ubuntu-700.woff2"),
    ("IBM Plex Mono", 400, "plexmono-400.woff2"),
    ("IBM Plex Mono", 500, "plexmono-500.woff2"),
    ("IBM Plex Mono", 600, "plexmono-600.woff2"),
]

THEME = {
    "pass": {
        "band": "#0B5C41",
        "band_deep": "#084A34",
        "accent": "#0B5C41",
        "node": "#129468",
        "mark": "✓",
        "word": "Passed",
        "headline": "Goal succeeded",
    },
    "fail": {
        "band": "#8C1D18",
        "band_deep": "#72130F",
        "accent": "#8C1D18",
        "node": "#D1453E",
        "mark": "✕",
        "word": "Failed",
        "headline": "Goal failed",
    },
    "neutral": {
        "band": "#3D4450",
        "band_deep": "#2C323C",
        "accent": "#3D4450",
        "node": "#6B7280",
        "mark": "•",
        "word": "Completed",
        "headline": "Run completed",
    },
    # US-047. Warm stone rather than the neutral slate: a stopped run is not the
    # same thing as one that ran to the end without reaching a verdict, and the
    # band is the only part of page 1 a reader takes in at a glance.
    "stopped": {
        "band": "#5A5248",
        "band_deep": "#453F37",
        "accent": "#5A5248",
        "node": "#8C8274",
        "mark": "■",
        "word": "Stopped",
        "headline": "Run stopped before it finished",
    },
}


def font_face_css() -> str:
    """Embed fonts as data URIs so the PDF looks identical everywhere.
    Silently skips files that are missing."""
    rules = []
    for family, weight, fname in FONT_FILES:
        path = os.path.join(FONTS_DIR, fname)
        try:
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
        except Exception:
            continue
        rules.append(
            "@font-face{font-family:'%s';font-style:normal;font-weight:%d;"
            "src:url(data:font/woff2;base64,%s) format('woff2');}"
            % (family, weight, b64)
        )
    return "\n".join(rules)


def build_html(data: dict) -> str:
    success = data.get("success")
    # A stopped run (US-047) is read off the status, not the verdict: it carries
    # no `success` at all, and letting it fall through to "neutral" would print
    # "Run completed" over steps that were cut short — the one thing the report
    # of a stopped run must not say.
    tone = (
        "stopped" if data.get("status") == "cancelled"
        else "pass" if success is True
        else "fail" if success is False
        else "neutral"
    )
    t = THEME[tone]

    stat_items = [
        ("URL", esc(data.get("start_url")), "stat-url", "url"),
        ("STEPS", esc(data.get("steps_count") or "—"), "", ""),
        ("DURATION", fmt_duration(data.get("duration_seconds")), "", ""),
        ("MODEL", esc(data.get("model") or "—"), "", ""),
    ]

    # US-046. Two more boxes, and only when the run counted something: on a
    # report from before this shipped — or one whose agent crashed before it
    # could summarise itself — there is no number, and a pair of dashes on the
    # cover of every archived report would be worse than the cover it replaced.
    #
    # "EST. COST" carries the qualifier, because a PDF outlives the screen it
    # was read on and this figure is priced from a table, not from the
    # provider's bill. Tokens keep their own box whatever the pricing did: on an
    # unpriced run they are the only measurement there is.
    usage = data.get("usage") or {}
    if usage.get("total_tokens") is not None:
        tokens = (
            f'{fmt_tokens(usage.get("total_tokens"))}'
            f'<span class="stat-sub">{fmt_tokens(usage.get("prompt_tokens"))} in'
            f' · {fmt_tokens(usage.get("completion_tokens"))} out</span>'
        )
        stat_items += [
            ("EST. COST", esc(fmt_cost(usage)), "", ""),
            ("TOKENS", tokens, "stat-wide", ""),
        ]

    stats_html = "".join(
        f'<div class="stat {box}"><div class="stat-k">{k}</div>'
        f'<div class="stat-v {vcls}">{v}</div></div>'
        for k, v, box, vcls in stat_items
    )

    # A run the navigation fence stopped (US-042) says so first, above the raw
    # errors: the agent's own message is a navigation failure, and a reader
    # left with only that would debug the site rather than the allowlist.
    blocked_html = ""
    # An expired session, likewise (US-043): the reader at 9am is looking at a
    # suite that went red at 3am, and the difference between "the login cookie
    # expired" and "the checkout button moved" is the whole value of the report.
    if data.get("failure_reason") == "session_expired":
        blocked_html = """
        <section class="errors">
          <div class="label">The saved session had expired</div>
          <ul><li>This test starts from a saved browser session, and that session was no
              longer signed in when the run began — so nothing after the login page was
              actually tested. Refresh the session in the project's settings, or re-run
              the login test that produces it.</li></ul>
        </section>"""
    elif data.get("failure_reason") == "navigation_blocked":
        blocked = data.get("blocked_url")
        target = f" to {esc(blocked)}" if blocked else ""
        blocked_html = f"""
        <section class="errors">
          <div class="label">Blocked by this instance</div>
          <ul><li>Navigation{target} was refused by the navigation policy.
              Check the project's allowed domains and QA_BLOCK_PRIVATE_NETWORKS.</li></ul>
        </section>"""

    # A run somebody steered proved less than one that finished alone (US-079),
    # and the verdict alone cannot say so. On the cover rather than in the log,
    # because the person who reads only the first page is exactly the person the
    # unqualified verdict would mislead.
    assisted_html = ""
    hints = data.get("hints") or []
    if data.get("assisted") or hints:
        items = "".join(
            f'<li><span class="hint-at">{esc(fmt_duration(h.get("elapsed")))}</span>'
            f'{esc(h.get("text"))}</li>'
            for h in hints
        )
        assisted_html = f"""
        <section class="assisted">
          <div class="label">This run was assisted</div>
          <p class="assisted-note">A person told the agent what to do while it was running.
             The verdict above covers the run as it happened, with that help — not the
             goal reached unaided.</p>
          <ul>{items}</ul>
        </section>"""

    errors = data.get("errors") or []
    errors_html = ""
    if errors:
        items = "".join(f"<li>{esc(e)}</li>" for e in errors)
        errors_html = f"""
        <section class="errors">
          <div class="label">Errors encountered</div>
          <ul>{items}</ul>
        </section>"""

    final = data.get("final_result")
    if final:
        # The agent's text often opens with "Goal succeeded:"/"Goal failed:" —
        # strip it so it doesn't duplicate our styled headline lead-in.
        final = re.sub(r"^\s*goal\s+(succeeded|failed)\s*[.:,-]?\s*", "", str(final), flags=re.I)
        summary_html = (
            f'<p class="summary-text"><strong style="color:{t["accent"]}">{t["headline"]}.</strong> '
            f'{esc(final)}</p>'
        )
    elif tone == "stopped":
        # A stopped run often has no summary of its own, and the generic
        # fallback below then reads as a run that failed to say anything rather
        # than one somebody ended — with the band the only thing left saying so.
        summary_html = (
            f'<p class="summary-text"><strong style="color:{t["accent"]}">{t["headline"]}.</strong> '
            f'The steps below are what ran before it was stopped.</p>'
        )
    else:
        summary_html = '<p class="summary-text muted">No summary text was produced.</p>'

    # What the browser said while this was failing (US-044). Its own section on
    # its own page: this is the part a developer reading a 3am failure mail
    # starts from, and it has to be findable without scrolling the whole log.
    # Step-stamped rather than nested inside the execution log, so it reads
    # correctly today and folds into that log when US-020 builds it.
    diagnostics_html = ""
    groups = group_diagnostics(data.get("diagnostics"))
    if groups:
        blocks = []
        for step, entries in groups:
            heading = f"Step {step}" if step is not None else "Before the first step"
            rows = "".join(
                f'<div class="diag-row">'
                # Keyed on severity, not kind: a console *error* is a failure and
                # reads red like the rest, only a warning is amber.
                f'<span class="diag-tag{" diag-warn" if e.get("level") == "warning" else ""}">'
                f"{esc(diagnostic_label(e))}</span>"
                f'<span class="diag-detail">{esc(diagnostic_detail(e))}</span>'
                f'<span class="diag-count">{esc(fmt_occurrences(e.get("count")))}</span>'
                f"</div>"
                for e in entries
            )
            blocks.append(
                f'<div class="diag-group"><div class="diag-step">{esc(heading)}</div>{rows}</div>'
            )
        dropped = data.get("diagnostics_dropped") or 0
        dropped_html = (
            f'<p class="diag-note">A further {esc(dropped)} distinct '
            f"{'finding' if dropped == 1 else 'findings'} exceeded the per-step "
            f"capture limit and were counted but not recorded.</p>"
            if isinstance(dropped, int) and dropped > 0
            else ""
        )
        diagnostics_html = f"""
        <section class="diagnostics">
          <div class="log-head">
            <div class="label">Browser diagnostics</div>
            <div class="log-count">{esc(sum(len(e) for _, e in groups))} findings</div>
          </div>
          <p class="diag-intro">Failed requests, console errors and uncaught exceptions
             captured while the test ran, in the order the browser reported them.</p>
          {"".join(blocks)}
          {dropped_html}
        </section>"""

    # A long instruction is the test itself, so none of it can be lost — but a
    # band that grows with it takes the cover with it, and the reader loses the
    # verdict to read the setup. The band gets an opening that fits; the body
    # gets every word.
    cover_goal, goal_clamped = clamp_goal(data.get("goal"))
    instruction_html = ""
    band_more = ""
    if goal_clamped:
        band_more = '<p class="band-more">Full instruction on the next page</p>'
        instruction_html = f"""
        <section class="instruction">
          <div class="log-head">
            <div class="label">Test instruction</div>
          </div>
          <p class="instruction-text">{esc(str(data.get("goal")).strip())}</p>
        </section>"""

    recording_url = data.get("recording_url")
    if recording_url:
        rec_cta = f'<a class="rec-cta" href="{esc(recording_url)}">▶&nbsp; View recording</a>'
        rec_note = "Full video replay of this test session."
    elif data.get("has_recording"):
        # Recorded, but this instance has no public address to link to.
        rec_cta = '<span class="rec-cta rec-cta-soon">In QAssist</span>'
        rec_note = "Full video replay of this session is available in the run view."
    else:
        rec_cta = '<span class="rec-cta rec-cta-soon">Not available</span>'
        rec_note = "Video replay of this session will be available at this link."
    recording_hero = f"""
        <div class="rec-hero">
          <div class="rec-hero-play">▶</div>
          <div class="rec-hero-text">
            <div class="rec-hero-title">Session recording</div>
            <div class="rec-hero-note">{rec_note}</div>
          </div>
          {rec_cta}
        </div>"""

    generated = fmt_date(data.get("generated_at"))

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  {font_face_css()}
  /* content pages get a uniform 44px margin on every page (incl. intermediate
     page breaks); the cover (page 1) is full-bleed for the verdict band. */
  @page {{ size: A4; margin: 44px; }}
  @page :first {{ margin: 0; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; }}
  body {{
    font-family: 'Ubuntu', system-ui, sans-serif;
    color: #14161A; font-size: 15px; line-height: 1.55; background: #fff;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }}
  .mono {{ font-family: 'IBM Plex Mono', ui-monospace, monospace; }}
  .muted {{ color: #8A9096; }}
  .label {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
    color: #6E747B; margin-bottom: 5px;
  }}

  /* ============ VERDICT BAND ============ */
  .band {{
    background: linear-gradient(160deg, {t["band"]} 0%, {t["band_deep"]} 100%);
    color: #fff; padding: 0 44px 40px;
  }}
  .band-top {{
    display: flex; align-items: center; justify-content: space-between;
    padding: 22px 0 18px; border-bottom: 1px solid rgba(255,255,255,.18);
  }}
  .wordmark {{ font-weight: 700; font-size: 16px; letter-spacing: -.01em; }}
  .wordmark .sub {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-weight: 500; font-size: 11.5px; letter-spacing: .16em; text-transform: uppercase;
    opacity: .6; margin-left: 12px;
  }}
  .band-meta {{ text-align: right; }}
  .band-date {{ font-family: 'IBM Plex Mono', ui-monospace, monospace;
                font-size: 13px; opacity: .75; }}
  .band-run {{ font-family: 'IBM Plex Mono', ui-monospace, monospace;
               font-size: 10px; opacity: .5; margin-top: 2px; }}
  .verdict {{ padding-top: 38px; display: flex; align-items: center; gap: 18px; }}
  .verdict-ring {{
    width: 46px; height: 46px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.9);
    display: flex; align-items: center; justify-content: center;
    font-size: 21px; font-weight: 700; flex: 0 0 auto;
  }}
  .verdict-word {{ font-size: 56px; font-weight: 700; letter-spacing: -.025em; line-height: 1; }}
  .band-goal {{
    font-size: 21px; font-weight: 400; line-height: 1.45; margin: 20px 0 0;
    max-width: 46ch; color: rgba(255,255,255,.92);
  }}
  .band-more {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11.5px; letter-spacing: .14em; text-transform: uppercase;
    color: rgba(255,255,255,.62); margin: 14px 0 0;
  }}
  .band-specs {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 30px; font-size: 13.5px;
  }}
  .spec {{ display: flex; gap: 9px; align-items: baseline; }}
  .spec-k {{ font-size: 11.5px; letter-spacing: .14em; opacity: .6; }}
  .spec-v {{ font-weight: 600; word-break: break-all; }}

  /* ============ BODY ============ */
  /* page 1 fills the full sheet so the cover-foot pins to the bottom */
  .page1 {{ display: flex; flex-direction: column; min-height: 296mm; }}
  .cover {{ flex: 1; display: flex; flex-direction: column; padding: 44px; }}
  .cover-foot {{ margin-top: auto; }}
  .content {{ }}

  /* stat boxes — cover page */
  .stats {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 13px; margin-bottom: 44px; }}
  .stat {{
    background: #fff; border: 1px solid #E4E6E8; border-radius: 13px;
    padding: 17px 20px; box-shadow: 0 2px 10px rgba(20,22,26,.04);
  }}
  .stat-url {{ grid-column: 1 / -1; }}
  /* US-046: the cost box takes one column and the tokens box the other two, so
     the pair fills its row rather than leaving a hole beside a short number. */
  .stat-wide {{ grid-column: span 2; }}
  .stat-k {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px; font-weight: 600; letter-spacing: .16em; text-transform: uppercase;
    color: #8A9096; margin-bottom: 8px;
  }}
  .stat-v {{ font-size: 23px; font-weight: 700; letter-spacing: -.015em; color: #14161A; }}
  .stat-v.url {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 16px; font-weight: 500; color: #14161A; word-break: break-all;
  }}
  /* The prompt/completion split rides beside the total rather than under it:
     it is the same fact at lower resolution, not a second one. */
  .stat-sub {{
    font-size: 13px; font-weight: 500; letter-spacing: 0; color: #8A9096;
    margin-left: 9px;
  }}

  .summary {{ margin-bottom: 40px; }}
  .summary .label {{ margin-bottom: 10px; }}
  /* the agent's line breaks are part of its summary, not stray whitespace */
  .summary-text {{
    font-size: 17px; line-height: 1.7; color: #45494F; margin: 0; max-width: 68ch;
    white-space: pre-line;
  }}
  .summary-text strong {{ font-weight: 700; }}

  .errors {{ margin: -16px 0 40px; }}
  .errors ul {{ margin: 6px 0 0; padding-left: 18px; color: #8C1D18; font-size: 15px; }}

  /* ============ ASSISTED RUN (US-079) ============ */
  /* Amber and not red: a hint is not a failure, it is a qualification on the
     verdict — so it must catch the eye without reading as an error. */
  .assisted {{
    margin: -16px 0 40px; padding: 14px 18px;
    background: #FFF8E6; border-left: 3px solid #C08A17; border-radius: 3px;
  }}
  .assisted .label {{ color: #7A5606; margin-bottom: 6px; }}
  .assisted-note {{ font-size: 14.5px; color: #6E5626; margin: 0; max-width: 68ch; }}
  .assisted ul {{ margin: 10px 0 0; padding-left: 18px; font-size: 15px; color: #45494F; }}
  .assisted li {{ margin-bottom: 4px; }}
  .hint-at {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12.5px; color: #8A9096; margin-right: 10px;
  }}

  /* ============ BROWSER DIAGNOSTICS (US-044) ============ */
  /* Its own page, straight after the cover: the reason the run failed is what
     a developer opens this report for, so it precedes the execution log. */
  .diagnostics {{ page-break-before: always; }}
  .diag-intro {{ font-size: 14.5px; color: #6E747B; margin: 0 0 24px; max-width: 68ch; }}
  .diag-group {{ margin-bottom: 22px; page-break-inside: avoid; }}
  .diag-step {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase;
    color: #14161A; padding-bottom: 6px; margin-bottom: 8px;
    border-bottom: 1px solid #E4E6E8;
  }}
  .diag-row {{
    display: grid; grid-template-columns: 64px 1fr auto; gap: 12px;
    align-items: baseline; padding: 7px 0; page-break-inside: avoid;
  }}
  .diag-row + .diag-row {{ border-top: 1px solid #F1F2F3; }}
  .diag-tag {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-align: center;
    padding: 3px 0; border-radius: 5px; color: #8C1D18; background: #FBEEED;
  }}
  /* A warning is not a failure — the one row here that isn't red. */
  .diag-warn {{ color: #7A4A0B; background: #FBF3E6; }}
  .diag-detail {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12.5px; line-height: 1.5; color: #45494F; word-break: break-word;
  }}
  .diag-count {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 11.5px; color: #8A9096; white-space: nowrap;
  }}
  .diag-note {{ font-size: 13px; color: #8A9096; margin-top: 18px; }}

  /* the instruction in full, for the run whose band could only hold its
     opening; the cover is page 1, so this lands on page 2 on its own */
  .instruction {{ page-break-before: always; }}
  /* a pasted instruction is usually a numbered list; the band flattens it to
     measure what it prints, but here it reads as it was typed */
  .instruction-text {{
    font-size: 17px; line-height: 1.75; color: #45494F; margin: 0; max-width: 68ch;
    white-space: pre-line;
  }}

  /* section head — browser diagnostics and the full instruction */
  .log-head {{
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1.5px solid #14161A; padding-bottom: 9px; margin-bottom: 28px;
  }}
  .log-head .label {{ color: #14161A; margin: 0; }}
  .log-count {{ font-family: 'IBM Plex Mono', ui-monospace, monospace;
                font-size: 12.5px; color: #8A9096; }}
  .label {{ page-break-after: avoid; }}

  /* recording hero — the marketing hook, on the cover */
  .rec-hero {{
    display: flex; align-items: center; gap: 18px;
    background: linear-gradient(135deg, {t["band"]} 0%, {t["band_deep"]} 100%);
    color: #fff; border-radius: 14px; padding: 20px 24px; margin-top: 8px;
    page-break-inside: avoid;
  }}
  .rec-hero-play {{
    width: 44px; height: 44px; border-radius: 50%; flex: 0 0 auto;
    background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.35);
    display: flex; align-items: center; justify-content: center; font-size: 15px;
  }}
  .rec-hero-text {{ flex: 1; }}
  .rec-hero-title {{ font-size: 18px; font-weight: 700; letter-spacing: -.01em; }}
  .rec-hero-note {{ font-size: 14px; color: rgba(255,255,255,.82); margin-top: 3px; }}
  .rec-cta {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 13px; font-weight: 600; color: {t["accent"]}; background: #fff;
    text-decoration: none; padding: 12px 20px; border-radius: 9px; white-space: nowrap;
  }}
  .rec-cta-soon {{ background: rgba(255,255,255,.16); color: rgba(255,255,255,.85); }}

  .footer {{
    margin-top: 40px; padding-top: 14px; border-top: 1px solid #E4E6E8;
    display: flex; justify-content: space-between;
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px; color: #8A9096;
  }}
</style></head>
<body>
  <div class="page1">
    <div class="band">
      <div class="band-top">
        <div class="wordmark">QAssist<span class="sub">Test Report</span></div>
        <div class="band-meta">
          <div class="band-date">{generated}</div>
          <div class="band-run">Run {esc(data.get("runId"))}</div>
        </div>
      </div>
      <div class="verdict">
        <div class="verdict-ring">{t["mark"]}</div>
        <div class="verdict-word">{t["word"]}</div>
      </div>
      <p class="band-goal">{esc(cover_goal)}</p>
      {band_more}
    </div>

    <div class="cover">
      <div class="stats">{stats_html}</div>

      <section class="summary">
        <div class="label">Summary</div>
        {summary_html}
      </section>

      {assisted_html}
      {blocked_html}
      {errors_html}

      <div class="cover-foot">
        {recording_hero}
      </div>
    </div>
  </div>

  {instruction_html}
  {diagnostics_html}
</body></html>"""


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: make_report.py <data.json> <out.pdf>", file=sys.stderr)
        return 2
    data_path, out_path = sys.argv[1], sys.argv[2]
    with open(data_path) as f:
        data = json.load(f)
    doc = build_html(data)

    # Imported here, not at module scope: everything above this line is stdlib
    # plus report_format, and that is what lets agent/tests/ cover build_html in
    # a CI job that installs pytest and nothing else. A module-level import
    # would make `import make_report` need Chromium's Python package to assert
    # on a string.
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = browser.new_page()
        page.set_content(doc, wait_until="load")
        page.pdf(
            path=out_path,
            format="A4",
            print_background=True,
            margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
        )
        browser.close()
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
