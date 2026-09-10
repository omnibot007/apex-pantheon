#!/usr/bin/env node
/**
 * Purge the triage ledger of rows written before the parser was fixed.
 *
 * triage.jsonl is append-only, so fixing the CODE did not fix the DATA. Two classes of
 * rot are in there from the first runs:
 *
 *   OUT OF RANGE   a loose two-group digit-colon-digit regex matched the echoed prompt's
 *                  numbered candidate list, producing scores of 40 and 34 on a 1-10
 *                  scale -- and those two rows ranked ABOVE everything real.
 *   UNSTAMPED      rows written before the lane was recorded. They cannot be attributed,
 *                  so they cannot corroborate anything and they cannot be audited.
 *
 * Backs up first, then rewrites. Never destructive without a stated backup path.
 *
 * Usage:
 *   node scripts/purge-triage.mjs           report only, changes nothing
 *   node scripts/purge-triage.mjs --apply   back up and rewrite
 *
 * SPDX-License-Identifier: MIT
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const FILE = join(homedir(), ".commandcode", "fam-gods", "triage.jsonl");
const APPLY = process.argv.includes("--apply");

if (!existsSync(FILE)) {
  process.stdout.write(`purge-triage: no ledger at ${FILE}\n`);
  process.exit(0);
}

const rows = readFileSync(FILE, "utf-8")
  .split("\n")
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });

const bad = [];
const unstamped = [];
const keep = [];
for (const r of rows) {
  if (typeof r.score !== "number" || r.score < 1 || r.score > 10) {
    bad.push(r);
    continue;
  }
  if (typeof r.lane !== "string" || r.lane === "") {
    unstamped.push(r);
    continue;
  }
  keep.push(r);
}

// De-duplicate on (donor, hunt, lane): a re-run of the same lane over the same candidate
// is a repeat measurement, not a second opinion, and counting it as one would fake
// corroboration. Newest wins.
const byKey = new Map();
for (const r of keep) byKey.set(`${r.donor}|${r.hunt}|${r.lane}`, r);
const deduped = [...byKey.values()];

const out = [
  `purge-triage  ${FILE}`,
  `  rows read          ${rows.length}`,
  `  OUT OF RANGE       ${bad.length}   (score outside 1-10 — the echoed-prompt bug)`,
  `  UNSTAMPED          ${unstamped.length}   (no lane recorded — unattributable)`,
  `  kept               ${keep.length}`,
  `  after de-dupe      ${deduped.length}   (unique donor+hunt+lane)`,
];
for (const r of bad.slice(0, 5)) out.push(`    dropped score=${r.score}  ${r.donor}`);

if (!APPLY) {
  out.push("", "  report only. re-run with --apply to back up and rewrite.");
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(0);
}

const backup = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
copyFileSync(FILE, backup);
writeFileSync(FILE, deduped.map((r) => JSON.stringify(r)).join("\n") + (deduped.length > 0 ? "\n" : ""));
out.push("", `  BACKUP  ${backup}`, `  WROTE   ${deduped.length} rows`);
process.stdout.write(`${out.join("\n")}\n`);
