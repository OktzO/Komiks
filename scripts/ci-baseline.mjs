#!/usr/bin/env node
// Baseline gate for a suite whose runner cannot say *which* failures occurred.
//
// `astro check` exits 1 for "there are errors" with no machine-readable way to
// tell one known pre-existing error from a new one. This reads its report and
// exits 0 only when the failing positions are EXACTLY the allowlist given as
// the second argument (pipe-separated). Equality both ways on purpose:
//
//   - an error outside the allowlist exits 1, so a new type error is red;
//   - an allowlisted error that has been fixed also exits 1, so the list
//     cannot rot into a permanent blanket. Dropping a fixed name is a
//     deliberate edit to the workflow, not a silent pass.
//
// Output that carries no Result block at all — a runner that died before
// reporting — is a failure too, so a crashing suite cannot read as "clean".
//
// Usage: <report> | node scripts/ci-baseline.mjs <file:line>|<file:line>
import { readFileSync } from 'node:fs';

// astro check colourises every diagnostic, so the source position is only
// matchable once the SGR sequences are gone.
const text = readFileSync(0, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');

if (!/^Result \(\d+ files?\)/m.test(text)) {
  console.error('ci-baseline: no Result block in the report — astro check did not run to completion.');
  process.exit(1);
}

// file:line only. The column moves with formatting and the surrounding
// formatting moves with the editor, so the position worth pinning is the
// source file and line. A Set, because one position is one entry.
const found = new Set([...text.matchAll(/^(src\/\S+?):(\d+):\d+ - error\b/gm)].map(([, file, line]) => `${file}:${line}`));
const allowed = new Set(process.argv[2]?.split('|').filter(Boolean) ?? []);

const added = [...found].filter((position) => !allowed.has(position));
const resolved = [...allowed].filter((position) => !found.has(position));

if (added.length === 0 && resolved.length === 0) {
  console.log(`ci-baseline: ${found.size} allowlisted error(s), none new.`);
  process.exit(0);
}

for (const position of added) console.error(`ci-baseline: NEW error — ${position}`);
for (const position of resolved) console.error(`ci-baseline: FIXED, drop from the allowlist — ${position}`);
process.exit(1);
