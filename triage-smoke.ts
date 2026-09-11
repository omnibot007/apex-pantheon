// triage-smoke.ts — the score parser, checked against real model output and real bugs.
//
// Every case below is a VERBATIM string that some model actually produced, or a shape a
// shipped bug actually matched. Nothing here is hypothetical: this parser has three
// separate scars on it, and all three looked like model failures at the time.
//
//   node triage-smoke.ts
import { parseScores, readScoreLine } from "./triage.ts";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}\n${ok ? "" : `          got  ${g}\n          want ${w}\n`}`);
}

process.stdout.write("PARSER\n");

// ── The shape the prompt asks for ───────────────────────────────────────────────
check("strict N:score", [...parseScores("1:9\n2:3\n3:10", 20)], [[1, 9], [2, 3], [3, 10]]);

// ── VERBATIM ling-3.0-flash-fin-free, captured 2026-09-10 from zen/v1 ───────────
// A 5-candidate probe: three real durable-workflow engines and two planted decoys.
// The model's JUDGEMENT was perfect (10/10/10 vs 1/1) and the single strict pattern
// matched NONE of these lines, which the runner reports as "ok=0 empty=1" -- visually
// identical to a dead lane. That is what this case exists to stop.
const LING_REAL = `1. inngest/inngest: 10
2. left-pad: 1
3. dbos-inc/dbos-transact-ts: 10
4. is-odd: 1
5. temporalio/temporal: 10`;
check("ling numbered-list shape", [...parseScores(LING_REAL, 20)], [[1, 10], [2, 1], [3, 10], [4, 1], [5, 10]]);
check("ling judged decoys low", parseScores(LING_REAL, 20).get(2), 1);

// ── The echoed prompt MUST NOT parse ────────────────────────────────────────────
// buildPrompt() emits `N. donor — summary`. A model that echoes its input back hands the
// harvester a string full of numbered lines. The widened shape only accepts a line
// ENDING in `: <1-2 digits>`, and prompt lines end in prose.
const ECHOED = `1. inngest/inngest — durable functions and workflow engine with retries
2. dbos-inc/dbos-transact-ts — durable execution library, resumable steps
3. temporalio/temporal — workflow orchestration with durable timers`;
check("echoed prompt yields nothing", [...parseScores(ECHOED, 20)], []);

// ── The 40/10 bug ───────────────────────────────────────────────────────────────
// A loose two-group pattern with no range check produced scores of 40 and 34 on a 1-10
// scale and ranked two pieces of noise above everything real. The range check, not the
// shape, is what kills this -- which is why widening the shape stayed safe.
check("score above 10 rejected", [...parseScores("1: 40\n2: 34", 20)], []);
check("score of zero rejected", [...parseScores("1: 0", 20)], []);

// ── Index must point inside the batch ───────────────────────────────────────────
check("index past batch rejected", [...parseScores("99: 5", 20)], []);
check("index zero rejected", [...parseScores("0: 5", 20)], []);

// ── Things that look like scores and are not ────────────────────────────────────
check("timestamp rejected", readScoreLine("elapsed 1:30", 20), null);
check("ratio in prose rejected", readScoreLine("a 1:1 mapping between them", 20), null);
check("trailing prose rejected", readScoreLine("3: 8 because it is durable", 20), null);

// ── Formatting slack that should still parse ────────────────────────────────────
check("spaces tolerated", readScoreLine("  7 : 9  ", 20), { idx: 7, score: 9 });
check("paren list marker", readScoreLine("7) owner/repo: 9", 20), { idx: 7, score: 9 });

process.stdout.write(failed === 0 ? "\nALL GREEN\n" : `\n${String(failed)} FAILED\n`);
process.exitCode = failed === 0 ? 0 : 1;
