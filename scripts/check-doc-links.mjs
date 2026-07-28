#!/usr/bin/env node
// Every relative link in a Markdown file must point at something that exists.
//
// This exists because of a failure it is easy to ship and impossible to see in
// review: `git mv`ing a finished story into `backlog/sprint/current/done/`
// silently breaks two kinds of link at once — the ones *inside* the moved file,
// which are now one directory deeper, and the ones *pointing at* it from
// elsewhere. Thirteen had accumulated by 2026-07-28 across twelve files.
//
// The check is deliberately file-existence only. Fragments are stripped rather
// than resolved: heading anchors have slug rules per renderer, and a checker
// that cries wolf about `#why-now` is one that gets muted.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Tracked *and* untracked-but-not-ignored, so a story written this minute is
// checked before it is ever committed — which is when the fix is free.
const markdownFiles = execFileSync(
  'git',
  ['ls-files', '-co', '--exclude-standard', '-z', '*.md'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
)
  .split('\0')
  .filter(Boolean);

const INLINE = /\[[^\]]*\]\(\s*<?([^)<>\s]+?)>?\s*(?:"[^"]*")?\s*\)/g;
// A reference definition. `- [ ] todo` can't match: that line starts with "- ".
const REFERENCE = /^\[[^\]]+\]:\s*<?([^\s<>]+)>?/;

/** Links we can't or shouldn't resolve on disk. */
function isExternal(target) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) || // http:, https:, mailto:, tel:, data:
    target.startsWith('//') ||
    target.startsWith('#') ||
    target.startsWith('/') // site-absolute; no docroot to resolve against
  );
}

const broken = [];

for (const file of markdownFiles) {
  const abs = resolve(repoRoot, file);
  const lines = readFileSync(abs, 'utf8').split('\n');
  let inFence = false;

  lines.forEach((line, index) => {
    // A path inside a fenced code block is an example, not a link.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const targets = [];
    for (const match of line.matchAll(INLINE)) targets.push(match[1]);
    const reference = line.match(REFERENCE);
    if (reference) targets.push(reference[1]);

    for (const target of targets) {
      if (isExternal(target)) continue;
      const withoutFragment = target.split('#')[0];
      if (!withoutFragment) continue;
      const decoded = decodeURIComponent(withoutFragment);
      if (existsSync(resolve(dirname(abs), decoded))) continue;
      broken.push({ file, line: index + 1, target });
    }
  });
}

if (broken.length) {
  console.error(`Broken relative links in Markdown (${broken.length}):\n`);
  for (const { file, line, target } of broken) {
    // `file:line` so an editor and GitHub's log both make it clickable.
    console.error(`  ${file}:${line}  ->  ${target}`);
  }
  console.error(
    '\nA story moved between folders is the usual cause: re-base the links in' +
      '\nthe moved file, and the links pointing at it.'
  );
  process.exit(1);
}

console.log(`All relative Markdown links resolve (${markdownFiles.length} files).`);
