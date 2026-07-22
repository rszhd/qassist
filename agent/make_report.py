"""Render a QA run's data JSON into a polished PDF report.

Usage:  make_report.py <data.json> <out.pdf>

"Verdict Band" design: the whole header IS the verdict — a full-bleed color
field (pine green pass / deep red fail). Below it, steps read as an execution
log with elapsed-time markers on a timeline rail.

Reuses the Chromium that browser-use already installed (via Playwright) to
convert an HTML template to PDF — highest fidelity, embeds screenshots and
fonts as data URIs, fully self-contained.

The data JSON shape is produced by the Express server (see generateReport()):
  { runId, goal, start_url, model, status, success, duration_seconds,
    steps_count, final_result, errors[], recording_url, generated_at,
    steps: [{ step, elapsed, next_goal, evaluation, url, screenshot_file }] }
Screenshot files are resolved relative to the data file's directory.
"""
from __future__ import annotations

import base64
import html
import json
import os
import re
import sys
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

# (family, weight, filename)
FONT_FILES = [
    ("Bricolage Grotesque", 400, "bricolage-400.woff2"),
    ("Bricolage Grotesque", 700, "bricolage-700.woff2"),
    ("Bricolage Grotesque", 800, "bricolage-800.woff2"),
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


def esc(v) -> str:
    return html.escape(str(v)) if v is not None else ""


def img_data_uri(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return f"data:image/png;base64,{b64}"
    except Exception:
        return None


def fmt_duration(secs) -> str:
    if not secs:
        return "—"
    secs = round(secs)
    if secs < 60:
        return f"{secs}s"
    return f"{secs // 60}m {secs % 60}s"


def fmt_elapsed(secs) -> str:
    if secs is None:
        return "—:—"
    secs = int(secs)
    return f"{secs // 60:02d}:{secs % 60:02d}"


def fmt_date(iso) -> str:
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%d · %H:%M UTC")
    except Exception:
        return esc(iso)


def step_ok(evaluation) -> bool | None:
    """Heuristic pass/fail marker per step from the agent's own evaluation text."""
    if not evaluation:
        return None
    text = str(evaluation).lower()
    if any(w in text for w in ("fail", "error", "block", "unable", "could not")):
        return False
    if "success" in text:
        return True
    return None


def build_html(data: dict, base_dir: str) -> str:
    success = data.get("success")
    tone = "pass" if success is True else "fail" if success is False else "neutral"
    t = THEME[tone]

    stat_items = [
        ("URL", esc(data.get("start_url")), "stat-url", "url"),
        ("STEPS", esc(data.get("steps_count") or "—"), "", ""),
        ("DURATION", fmt_duration(data.get("duration_seconds")), "", ""),
        ("MODEL", esc(data.get("model") or "—"), "", ""),
    ]
    stats_html = "".join(
        f'<div class="stat {box}"><div class="stat-k">{k}</div>'
        f'<div class="stat-v {vcls}">{v}</div></div>'
        for k, v, box, vcls in stat_items
    )

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
    else:
        summary_html = '<p class="summary-text muted">No summary text was produced.</p>'

    steps = data.get("steps", [])
    steps_html = ""
    for i, s in enumerate(steps):
        first = " first" if i == 0 else ""
        last = " last" if i == len(steps) - 1 else ""
        shot = s.get("screenshot_file")
        uri = img_data_uri(os.path.join(base_dir, shot)) if shot else None
        shot_area = (
            f'<div class="shot-area"><img src="{uri}" alt="step screenshot"/></div>'
            if uri
            else '<div class="shot-area shot-empty">SCREENSHOT</div>'
        )
        # Full-width screenshot in a faux browser chrome; the step URL lives
        # in its address bar.
        addr = (
            f'<span class="addr">{esc(s.get("url"))}</span>' if s.get("url") else ""
        )
        browser_frame = f"""
            <div class="shot">
              <div class="shot-chrome">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                {addr}
              </div>
              {shot_area}
            </div>"""
        ok = step_ok(s.get("evaluation"))
        ok_html = (
            '<span class="ok-mark">· OK</span>' if ok is True
            else '<span class="ok-mark bad">· FAILED</span>' if ok is False
            else ""
        )
        eval_html = (
            f'<div class="label lbl-gap">Result</div>'
            f'<p class="step-p">{esc(s.get("evaluation"))} {ok_html}</p>'
            if s.get("evaluation")
            else ""
        )
        steps_html += f"""
        <div class="log-step{first}{last}">
          <div class="log-time">{fmt_elapsed(s.get("elapsed"))}</div>
          <div class="log-rail"><span class="node{' node-bad' if ok is False else ''}"></span><span class="rail-line"></span></div>
          <div class="log-body">
            <h3>Step {esc(s.get("step"))}</h3>
            <div class="label">Action</div>
            <p class="step-p">{esc(s.get("next_goal"))}</p>
            {eval_html}
            <div class="shot-wrap">{browser_frame}</div>
          </div>
        </div>"""

    recording_url = data.get("recording_url")
    if recording_url:
        rec_cta = f'<a class="rec-cta" href="{esc(recording_url)}">▶&nbsp; View recording</a>'
        rec_note = "Full video replay of this test session."
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

    scroll_cta = """
        <div class="scroll-cta">
          <div class="scroll-cta-main">Execution log continues on the following pages</div>
          <div class="scroll-arrow">↓</div>
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
    font-family: 'Bricolage Grotesque', system-ui, sans-serif;
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
  .verdict-word {{ font-size: 56px; font-weight: 800; letter-spacing: -.025em; line-height: 1; }}
  .band-goal {{
    font-size: 21px; font-weight: 400; line-height: 1.45; margin: 20px 0 0;
    max-width: 46ch; color: rgba(255,255,255,.92);
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

  .summary {{ margin-bottom: 40px; }}
  .summary .label {{ margin-bottom: 10px; }}
  .summary-text {{ font-size: 17px; line-height: 1.7; color: #45494F; margin: 0; max-width: 68ch; }}
  .summary-text strong {{ font-weight: 700; }}

  .errors {{ margin: -16px 0 40px; }}
  .errors ul {{ margin: 6px 0 0; padding-left: 18px; color: #8C1D18; font-size: 15px; }}

  /* execution log always starts on a fresh page */
  .exec {{ page-break-before: always; }}
  .log-head {{
    display: flex; justify-content: space-between; align-items: baseline;
    border-bottom: 1.5px solid #14161A; padding-bottom: 9px; margin-bottom: 28px;
  }}
  .log-head .label {{ color: #14161A; margin: 0; }}
  .log-count {{ font-family: 'IBM Plex Mono', ui-monospace, monospace;
                font-size: 12.5px; color: #8A9096; }}

  /* one execution step per page: each step fills the page so the rail runs
     top-to-bottom; keep each step whole and start each on a new page */
  .log-step {{
    display: grid; grid-template-columns: 52px 24px 1fr;
    page-break-inside: avoid; page-break-before: always;
    min-height: 255mm;
  }}
  .log-step.first {{ page-break-before: avoid; min-height: 242mm; }}
  .log-time {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 13px; font-weight: 500; color: #8A9096; padding-top: 3px;
  }}
  .log-rail {{ position: relative; }}
  .node {{
    position: absolute; left: 4px; top: 4px; width: 11px; height: 11px;
    border-radius: 50%; background: {t["node"]}; box-shadow: 0 0 0 3px #fff; z-index: 1;
  }}
  .node-bad {{ background: #D1453E; }}
  .rail-line {{
    position: absolute; left: 8.5px; top: 15px; bottom: 0; width: 2px; background: #E4E6E8;
  }}
  .log-body {{ min-width: 0; display: flex; flex-direction: column; }}
  /* screenshot centers in the space below the text so the page reads balanced */
  .shot-wrap {{ flex: 1; display: flex; align-items: center; margin-top: 20px; }}
  .shot-wrap .shot {{ margin-top: 0; width: 100%; }}
  .log-body h3 {{
    font-size: 20px; font-weight: 700; letter-spacing: -.01em;
    margin: 0 0 10px; color: #14161A;
    page-break-after: avoid;
  }}
  .label {{ page-break-after: avoid; }}
  .lbl-gap {{ margin-top: 13px; }}
  .step-p {{ font-size: 15.5px; line-height: 1.65; color: #45494F; margin: 0; max-width: 64ch; }}
  .ok-mark {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px; font-weight: 600; color: {t["accent"]}; margin-left: 3px;
  }}
  .ok-mark.bad {{ color: #8C1D18; }}

  /* full-width screenshot in a faux browser chrome */
  .shot {{
    margin-top: 16px; border-radius: 10px; border: 1px solid #E4E6E8;
    overflow: hidden; background: #fff;
    box-shadow: 0 1px 3px rgba(20,22,26,.05);
    page-break-inside: avoid;
  }}
  .shot-chrome {{
    display: flex; align-items: center; gap: 5px;
    padding: 8px 12px; background: #F5F6F7; border-bottom: 1px solid #E4E6E8;
  }}
  .dot {{ width: 8px; height: 8px; border-radius: 50%; background: #D6D9DC; }}
  .addr {{
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12.5px; color: #6E747B; background: #fff; border: 1px solid #E4E6E8;
    border-radius: 5px; padding: 3px 11px; margin-left: 7px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;
  }}
  .shot-area {{ background: #fff; }}
  .shot-area img {{ width: 100%; display: block; }}
  .shot-empty {{
    height: 180px; display: flex; align-items: center; justify-content: center;
    font-family: 'IBM Plex Mono', ui-monospace, monospace;
    font-size: 12px; letter-spacing: .12em; color: #8A9096;
    background: linear-gradient(135deg, #F6F7F8 0%, #EDEFF1 100%);
  }}

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

  /* scroll prompt — invite the reader into the detailed log */
  .scroll-cta {{
    text-align: center; margin-top: 30px; page-break-inside: avoid;
  }}
  .scroll-cta-main {{ font-size: 17px; font-weight: 700; color: #14161A; letter-spacing: -.01em; }}
  .scroll-cta-sub {{ font-size: 13.5px; color: #8A9096; margin-top: 5px; }}
  .scroll-arrow {{ font-size: 24px; color: {t["accent"]}; margin-top: 12px; line-height: 1; }}

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
      <p class="band-goal">{esc(data.get("goal"))}</p>
    </div>

    <div class="cover">
      <div class="stats">{stats_html}</div>

      <section class="summary">
        <div class="label">Summary</div>
        {summary_html}
      </section>

      {errors_html}

      <div class="cover-foot">
        {recording_hero}
      </div>
    </div>
  </div>
</body></html>"""


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: make_report.py <data.json> <out.pdf>", file=sys.stderr)
        return 2
    data_path, out_path = sys.argv[1], sys.argv[2]
    with open(data_path) as f:
        data = json.load(f)
    base_dir = os.path.dirname(os.path.abspath(data_path))
    doc = build_html(data, base_dir)

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
