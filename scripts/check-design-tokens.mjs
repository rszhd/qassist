#!/usr/bin/env node
// The token index in `docs/design-system.md` must list exactly the tokens that
// `frontend/src/App.css` declares.
//
// The index exists so a rule can be written without opening the stylesheet —
// which only holds while the two agree. A copy of the values is a copy that
// drifts, and the drift is invisible: the app keeps working, the doc quietly
// starts describing a palette nobody ships.
//
// Names are checked for every token, in both directions — one missing from the
// index, and one documented after it was deleted from the CSS.
//
// Values are checked only where the index gives them in a table row, which is
// every colour, overlay and shadow. The spacing/size/type/radii tokens are
// written as prose runs (`--s1` 4px · `--s2` 8px) and are name-checked only:
// parsing a value out of a run means teaching this script the difference
// between `.75rem/12px` and `calc(var(--topbar-h) + var(--s4))`, and a checker
// that fights the doc's formatting is one that gets deleted.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cssPath = 'frontend/src/App.css';
const docPath = 'docs/design-system.md';

const css = readFileSync(resolve(repoRoot, cssPath), 'utf8');
const doc = readFileSync(resolve(repoRoot, docPath), 'utf8');

/** Whitespace is presentation: the doc packs `rgba(19,19,22,.85)`, CSS spaces it. */
const normalize = (value) => value.replace(/\s+/g, '').toLowerCase();

/** The declarations inside one `:root...{ }` block, as name -> value. */
function declarations(selector) {
  const start = css.indexOf(selector);
  if (start === -1) fail(`${cssPath} has no \`${selector}\` block.`);
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');

  const found = new Map();
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(`--${name}`, value.trim());
  }
  return found;
}

const dark = declarations(':root {');
const light = declarations(":root[data-theme='light'] {");

// The section, not the whole file: tokens are named in the prose above it too,
// and a passing mention there is not an index entry.
const section = doc.match(/^## Token index$([\s\S]*?)^## /m);
if (!section) fail(`${docPath} has no \`## Token index\` section.`);

const documented = new Set();
/** name -> {dark, light} for the tokens the index tabulates. */
const tabulated = new Map();

for (const line of section[1].split('\n')) {
  if (!line.trimStart().startsWith('|')) {
    // A prose run: `--s1` 4px · `--s2` 8px — names only.
    for (const [, name] of line.matchAll(/`(--[a-z0-9-]+)`/g)) documented.add(name);
    continue;
  }
  // Backticks are load-bearing: they are what stops a `| --- |` separator row
  // from reading as a token named `---`.
  const cells = line.split('|').map((cell) => cell.trim());
  cells.forEach((cell, index) => {
    const name = cell.match(/^`(--[a-z0-9-]+)`$/);
    if (!name) return;
    documented.add(name[1]);
    const [darkCell, lightCell] = [cells[index + 1], cells[index + 2]];
    if (darkCell && lightCell) {
      tabulated.set(name[1], {
        dark: darkCell.replace(/`/g, ''),
        light: lightCell.replace(/`/g, ''),
      });
    }
  });
}

const problems = [];

for (const name of dark.keys()) {
  if (!documented.has(name)) problems.push(`${name} — declared in ${cssPath}, missing from the index`);
}
for (const name of documented) {
  if (!dark.has(name)) problems.push(`${name} — in the index, not declared in ${cssPath}`);
}

// The doc's own claim about the light theme: it overrides tokens and nothing
// else. A name here that `:root` never declared means a rule is reaching past
// the tokens, which is worth catching wherever it shows up.
for (const name of light.keys()) {
  if (!dark.has(name)) problems.push(`${name} — in the light theme, never declared in \`:root\``);
}

for (const [name, indexed] of tabulated) {
  const actual = { dark: dark.get(name), light: light.get(name) ?? dark.get(name) };
  for (const theme of ['dark', 'light']) {
    if (actual[theme] === undefined) continue;
    if (normalize(indexed[theme]) === normalize(actual[theme])) continue;
    problems.push(`${name} (${theme}) — index says ${indexed[theme]}, ${cssPath} says ${actual[theme]}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (problems.length) {
  console.error(`Design tokens and their index disagree (${problems.length}):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nAdding, renaming or retuning a token means editing both ${cssPath}\nand the token index in ${docPath}.`);
  process.exit(1);
}

console.log(
  `Token index matches ${cssPath} (${dark.size} tokens, ${tabulated.size} with values).`
);
