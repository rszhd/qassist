"""Render a QA run's data JSON into a polished PDF report.

Usage:  make_report.py <data.json> <out.pdf>

Reuses the Chromium that browser-use already installed (via Playwright) to
convert an HTML template to PDF — highest fidelity, embeds screenshots as
data URIs, no extra dependencies.

The data JSON shape is produced by the Express server (see generateReport()):
  { runId, goal, start_url, model, status, success, duration_seconds,
    steps_count, final_result, errors[], recording_url, generated_at,
    steps: [{ step, next_goal, evaluation, url, screenshot_file }] }
Screenshot files are resolved relative to the data file's directory.
"""
from __future__ import annotations

import base64
import html
import json
import os
import sys

from playwright.sync_api import sync_playwright


def esc(v) -> str:
    return html.escape(str(v)) if v is not None else ""


def img_data_uri(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return f"data:image/png;base64,{b64}"
    except Exception:
        return None


def build_html(data: dict, base_dir: str) -> str:
    success = data.get("success")
    status = (data.get("status") or "completed").upper()
    passed = success is True
    failed = success is False
    pill_class = "pass" if passed else "fail" if failed else "neutral"
    pill_text = "PASSED" if passed else "FAILED" if failed else status

    meta = [
        ("Start URL", esc(data.get("start_url"))),
        ("Model", esc(data.get("model"))),
        ("Steps", esc(data.get("steps_count"))),
        ("Duration", f"{round(data['duration_seconds'])}s" if data.get("duration_seconds") else "—"),
        ("Generated", esc(data.get("generated_at"))),
    ]
    meta_rows = "".join(
        f'<div class="meta-item"><dt>{k}</dt><dd>{v}</dd></div>' for k, v in meta
    )

    errors = data.get("errors") or []
    errors_html = ""
    if errors:
        items = "".join(f"<li>{esc(e)}</li>" for e in errors)
        errors_html = f"""
        <section class="errors">
          <h2>Errors encountered</h2>
          <ul>{items}</ul>
        </section>"""

    final = data.get("final_result")
    summary_html = f'<p class="final">{esc(final)}</p>' if final else ""

    steps_html = ""
    for s in data.get("steps", []):
        shot = s.get("screenshot_file")
        uri = img_data_uri(os.path.join(base_dir, shot)) if shot else None
        img = (
            f'<img src="{uri}" alt="step screenshot" />'
            if uri
            else '<div class="no-shot">no screenshot</div>'
        )
        eval_html = (
            f'<p class="eval"><span class="lbl">Result of previous action</span>{esc(s.get("evaluation"))}</p>'
            if s.get("evaluation")
            else ""
        )
        url_html = f'<div class="step-url">{esc(s.get("url"))}</div>' if s.get("url") else ""
        steps_html += f"""
        <div class="step">
          <div class="step-shot">{img}</div>
          <div class="step-body">
            <div class="step-head"><span class="step-n">Step {esc(s.get("step"))}</span>{url_html}</div>
            <p class="action"><span class="lbl">Action</span>{esc(s.get("next_goal"))}</p>
            {eval_html}
          </div>
        </div>"""

    recording_url = data.get("recording_url")
    if recording_url:
        rec_html = f'<a href="{esc(recording_url)}">{esc(recording_url)}</a>'
    else:
        rec_html = '<span class="pending">Recording hosting coming soon — this link will point to the full session playback.</span>'

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; }}
  body {{ font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          color: #1a2230; font-size: 12px; line-height: 1.5; }}
  .page {{ padding: 40px 44px; }}
  .brand {{ font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
            color: #6b7688; font-weight: 700; }}
  h1 {{ font-size: 21px; margin: 6px 0 2px; font-weight: 700; }}
  .goal {{ font-size: 14px; color: #33405a; margin: 0 0 18px; }}
  .pill {{ display: inline-block; padding: 4px 14px; border-radius: 999px; color: #fff;
           font-weight: 700; font-size: 12px; letter-spacing: .05em; }}
  .pill.pass {{ background: #16a34a; }}
  .pill.fail {{ background: #dc2626; }}
  .pill.neutral {{ background: #4b5563; }}
  .top {{ display: flex; justify-content: space-between; align-items: flex-start; }}
  .meta {{ display: flex; flex-wrap: wrap; gap: 0; margin: 18px 0 24px;
           border: 1px solid #e2e6ee; border-radius: 10px; overflow: hidden; }}
  .meta-item {{ flex: 1 1 33%; padding: 10px 14px; border-right: 1px solid #e2e6ee;
               border-bottom: 1px solid #e2e6ee; }}
  .meta-item dt {{ font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
                   color: #8a94a6; margin: 0 0 2px; }}
  .meta-item dd {{ margin: 0; font-weight: 600; font-size: 12.5px; word-break: break-word; }}
  h2 {{ font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #6b7688;
        margin: 22px 0 10px; border-bottom: 1px solid #e2e6ee; padding-bottom: 6px; }}
  .summary {{ background: #f6f8fb; border: 1px solid #e2e6ee; border-radius: 10px;
              padding: 14px 16px; }}
  .final {{ margin: 0; font-size: 12.5px; color: #26324a; }}
  .errors ul {{ margin: 0; padding-left: 18px; color: #b42318; }}
  .step {{ display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid #eef1f6;
           page-break-inside: avoid; }}
  .step-shot {{ flex: 0 0 260px; }}
  .step-shot img {{ width: 260px; border: 1px solid #dfe4ec; border-radius: 8px; display: block; }}
  .no-shot {{ width: 260px; height: 150px; border: 1px dashed #cfd6e2; border-radius: 8px;
              display: flex; align-items: center; justify-content: center; color: #9aa4b4; }}
  .step-body {{ flex: 1; }}
  .step-head {{ display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }}
  .step-n {{ font-weight: 700; color: #2563eb; font-size: 13px; }}
  .step-url {{ font-size: 10.5px; color: #8a94a6; word-break: break-all; }}
  .lbl {{ display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
          color: #9aa4b4; margin-bottom: 1px; }}
  .action {{ margin: 0 0 8px; font-weight: 600; }}
  .eval {{ margin: 0; color: #47536b; }}
  .footer {{ margin-top: 26px; padding-top: 14px; border-top: 2px solid #1a2230;
             font-size: 11px; color: #47536b; }}
  .footer .rec {{ font-weight: 600; color: #1a2230; }}
  .pending {{ color: #8a94a6; font-style: italic; font-weight: 400; }}
</style></head>
<body><div class="page">
  <div class="top">
    <div>
      <div class="brand">QAgent · Test Report</div>
      <h1>{esc(data.get("goal"))[:120] or "Test run"}</h1>
      <p class="goal">{esc(data.get("goal"))}</p>
    </div>
    <span class="pill {pill_class}">{pill_text}</span>
  </div>

  <div class="meta">{meta_rows}</div>

  <section class="summary">
    <h2 style="margin-top:0">Summary</h2>
    {summary_html or '<p class="final">No summary text was produced.</p>'}
  </section>

  {errors_html}

  <h2>Steps &amp; actions</h2>
  {steps_html or '<p style="color:#8a94a6">No step screenshots were captured.</p>'}

  <div class="footer">
    <div class="rec">Live recording</div>
    {rec_html}
    <div style="margin-top:8px; color:#9aa4b4;">Run ID: {esc(data.get("runId"))}</div>
  </div>
</div></body></html>"""


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
