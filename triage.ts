// triage.ts — score a loot ledger across independent quota lanes.
//
// The job: the triageable rows in apex-memory's loot ledger -- unseen, and carrying a
// summary a model can actually judge -- harvested and labelled by omnithief and never
// read by anything. Deterministic labels got them into the vault; only a model can put
// them in a useful order.
//
// DO NOT WRITE THE BACKLOG SIZE HERE. Run `node triage.ts --backlog`. It counts with
// isTriageable(), the same predicate main() loads with, and prints the rule beside the
// number so the two can never travel apart. This line used to read "4,982" while the
// rule itself sat 240 lines below it; a later reader counted "unseen with ANY summary"
// instead, got 11,642, and went looking for a data problem that was only ever a
// mis-stated filter. Before that, "8,137" -- the entire ledger, judged rows and all --
// was quoted for a while. Three different numbers, one missing predicate.
//
// TWO LANES, two different ACCOUNTS, so their rate limits are independent:
//
//   cline  cline's own free tier    muse-spark-1.3-contributor   1.13s/candidate  $0
//   go     the operator's $10 sub   deepseek-flash (V4.1, 4x)    1.22s/candidate  ~$1.18
//
// KILO WAS DROPPED. Its gateway worked beautifully in isolation -- 40/40 in 14.7s,
// anonymous, cost 0 -- and then degraded to 3 batches out of 8 on a real run, which is
// the documented 200 req/hr/IP anonymous cap arriving. An unreliable lane is worse than
// no lane: it silently drops candidates, and this run lost 200 rows that way. A
// KILO_API_KEY from app.kilo.ai would lift the cap and make it viable again.
//
// TWO MODES, and the difference is the whole point:
//
//   throughput (default)  lanes take DISJOINT batches. Fast. Every score is one model's
//                         unverified opinion.
//   --consensus           every candidate goes to EVERY lane. Twice the calls, and the
//                         only mode that produces CORROBORATION. Measured: a blended
//                         throughput run put `sort-asc` and `sort-object` -- trivial
//                         string sorters -- at 10/10 for a dependency planner, on a
//                         keyword match. Two independent models agreeing does not do
//                         that. The verdict folds on the FLOOR, never the mean, because
//                         a candidate is only as good as the least impressed model.
//
// FOUR THINGS THAT WILL BITE WHOEVER TOUCHES THIS NEXT, all measured:
//
// 1. ASK FOR A SCORE, NEVER A VERDICT. A binary RELEVANT/IRRELEVANT scored 4/6 and
//    rejected BOTH donors that were actually taken from that raid. The same model on a
//    1-10 score separated cleanly: real donors 6,6 against noise 2,2,1. A binary forces
//    a gate; a score gives a reading order, which is all this needs.
// 2. REASONING MODELS EAT THE BUDGET. deepseek-flash spent 3,000 of 3,000 output tokens
//    as reasoning_tokens and returned EMPTY -- which reads exactly like a crashed
//    request. Budget generously. ling-3.0-flash-fin:free fails the same way at 40.
// 3. BATCH SIZE IS THE WHOLE OPTIMISATION. CLI startup is ~33s and FIXED per call, so it
//    amortises: 40 candidates per call turns a 45s call into 1.13s per candidate.
// 4. THE CLI LANES CARRY A DIFFERENT CREDENTIAL than the API key. muse-spark-1.3-
//    contributor is HTTP 403 DataPolicyError through the Go API key and answers fine
//    through cline, because it is cline's account and cline's opt-in.
//
// Usage:
//   node triage.ts --backlog                        what is left, per hunt, with the rule
//   node triage.ts --hunt "<hunt>" [--limit 400] [--batch 40] [--lanes cline,go]
//   node triage.ts --hunt "<hunt>" --consensus     every lane scores every candidate
//   node triage.ts --hunt "<hunt>" --dry            plan only, no calls
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOOT = join(homedir(), ".apex-memory", "loot.jsonl");
const OUT_DIR = join(homedir(), ".commandcode", "fam-gods");
const SCRATCH = join(process.env.TEMP ?? "/tmp", "apex-triage");
/** Empty working directory for the agent CLIs — see the note in runCli(). */
const SANDBOX = join(SCRATCH, "sandbox");

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || process.argv[i + 1] === undefined ? dflt : process.argv[i + 1];
}
const DRY = process.argv.includes("--dry");
/** Report what is left to triage, with the rule that defines it, and call nothing. */
const BACKLOG = process.argv.includes("--backlog");
/** Send every candidate to EVERY lane, so agreement between them is measurable. */
const CONSENSUS = process.argv.includes("--consensus");
const HUNT = arg("hunt", "");
const LIMIT = Number(arg("limit", "400"));
const BATCH = Number(arg("batch", "40"));
// DEFAULT IS go,zen -- two tier-1 models, one credential, both HTTP.
// `cline` was the default and is no longer: cline 3.0.61 is an autonomous coding agent,
// and handed a scoring prompt it answered by running `dir`, burning 8,382 input tokens
// of its own system prompt on iteration 1 and returning no scores. Not auth, not quota
// (totalCost 0) -- the same defect that retired `kilo run`, and triage.ts ALREADY runs it
// in an empty cwd, so the sandbox mitigation is not enough. Pass --lanes cline,go to try
// it anyway.
const LANES = arg("lanes", "go,zen").split(",").map((s) => s.trim());

interface LootRow {
  donor: string;
  hunt: string;
  summary: string;
  verdict: string;
}

/**
 * THE ONE DEFINITION OF "TRIAGEABLE". main() loads with it and --backlog counts with it,
 * so the reported number cannot drift from the work actually queued.
 *
 * Why a constant beside the predicate: a count is not a fact unless its filter travels
 * with it. Every wrong backlog figure this project has produced came from separating the
 * two -- see the header. `--backlog` prints RULE next to the number for that reason.
 *
 * The `> 25` bar is not arbitrary: omnithief writes short deterministic stubs ("pending",
 * a bare topic word) for rows it could not summarise, and a model handed one of those is
 * scoring a label, not a candidate. 25 characters is where a real one-line description
 * starts.
 */
const TRIAGEABLE_RULE = 'verdict === "unseen" && summary.length > 25';
function isTriageable(r: LootRow): boolean {
  return r.verdict === "unseen" && String(r.summary ?? "").length > 25;
}

function readLoot(): LootRow[] {
  return readFileSync(LOOT, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LootRow);
}

/** Count what is left, per hunt, and show the rule that decided it. Calls nothing. */
function reportBacklog(): void {
  const rows = readLoot();
  const byHunt = new Map<string, number>();
  let triageable = 0;
  let judged = 0;
  let thin = 0;
  for (const r of rows) {
    if (r.verdict !== "unseen") {
      judged += 1;
      continue;
    }
    if (!isTriageable(r)) {
      thin += 1;
      continue;
    }
    triageable += 1;
    byHunt.set(r.hunt, (byHunt.get(r.hunt) ?? 0) + 1);
  }
  const ranked = [...byHunt.entries()].sort((a, b) => b[1] - a[1]);
  process.stdout.write(
    `BACKLOG  ${LOOT}\n` +
      `  RULE  ${TRIAGEABLE_RULE}\n\n` +
      `  ${String(rows.length).padStart(6)}  rows in ledger\n` +
      `  ${String(judged).padStart(6)}  already judged (verdict is not "unseen")\n` +
      `  ${String(thin).padStart(6)}  unseen but summary too thin to judge\n` +
      `  ${String(triageable).padStart(6)}  TRIAGEABLE\n\n` +
      ranked.map(([h, n]) => `  ${String(n).padStart(6)}  ${h}`).join("\n") +
      `\n\n  node triage.ts --hunt "<hunt>" --consensus\n`,
  );
}

interface Lane {
  id: string;
  bin: string;
  model: string;
  batch: number;
  /** Build argv for one batch. */
  argv: (promptFile: string, prompt: string) => string[];
  parse: (raw: string) => string;
}

const LANE_SPECS: Record<string, Lane> = {
  // Muse Spark 1.3 CONTRIBUTOR -- the 45,300/5hr tier -- reachable here and nowhere else.
  cline: {
    id: "cline",
    bin: "cline",
    model: "cline-free/muse-spark-1.3-contributor",
    batch: 40,
    argv: (_f, p) => ["--json", "--timeout", "260", "-m", "cline-free/muse-spark-1.3-contributor", p],
    parse: harvestText,
  },
};

/**
 * HTTP lanes -- no subprocess, so no startup tax, so a smaller batch costs nothing.
 *
 * TWO KINDS OF INDEPENDENCE, and this file used to conflate them. Separate ACCOUNTS buy
 * throughput: their rate limits do not stack. Separate MODELS buy corroboration: two
 * judgements that can actually disagree. Tying the two together is why losing one CLI
 * account took the agreement signal with it, while a tier-1 second opinion sat unused on
 * a credential already loaded. `zen` is that second opinion: a DIFFERENT model reached
 * with the SAME key, which buys agreement without buying throughput. Worth knowing which
 * one you are short of.
 *
 * ONLY TIER-1 MODELS BELONG HERE. glm-5.3-flash and deepseek-v4-flash ride this very key
 * and are both tier 3 -- "WRONG on: triage" in legs.config.json. They answer fast and
 * confidently and called a DAG renderer irrelevant to a dependency planner. A wrong
 * second opinion is worse than none: it manufactures agreement.
 */
const HTTP_LANE_SPECS: Record<string, { url: string; model: string; batch: number }> = {
  go: { url: "https://opencode.ai/zen/go/v1/chat/completions", model: "deepseek-flash", batch: 20 },
  zen: { url: "https://opencode.ai/zen/v1/chat/completions", model: "ling-3.0-flash-fin-free", batch: 20 },
};

async function httpBatch(lane: string, prompt: string): Promise<string> {
  const spec = HTTP_LANE_SPECS[lane];
  if (spec === undefined) throw new Error(`no HTTP spec for lane '${lane}'`);
  // NOT vestigial, and the discarded return value makes it look it: buildPool() is what
  // reads ~/.config/opencode/.go-key into process.env via fileKeyEnv (legs.ts:133).
  // Drop this line and both HTTP lanes work only for a shell that already exported the
  // variable by hand -- green on the developer's machine, dead on a fresh one.
  const { buildPool } = await import("./legs.ts");
  buildPool("triage");
  const key = process.env.OPENCODE_GO_KEY;
  if (!key) throw new Error("OPENCODE_GO_KEY not loaded (no env var and no ~/.config/opencode/.go-key)");
  const r = await fetch(spec.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "fam-gods/1.0",
      "x-opencode-session": `triage-${Date.now()}`,
    },
    // 8000, not 3000: these models spend thousands of tokens reasoning before answering,
    // and a tight cap returns EMPTY, which reads exactly like a crashed request. Measured
    // on ling: 333 of 369 completion tokens were reasoning_tokens on a 5-candidate probe.
    body: JSON.stringify({ model: spec.model, messages: [{ role: "user", content: prompt }], max_tokens: 8000 }),
    signal: AbortSignal.timeout(240_000),
  });
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: unknown };
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
  return j.choices?.[0]?.message?.content ?? "";
}

function runCli(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // .cmd shims need shell:true on Node 24, and stdin MUST be ignored -- cline and kilo
    // treat an open stdin pipe as piped context and wait forever. Same fix as cli-legs.ts.
    const q = (a: string) => (/[\s&|<>()%^!"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const child = spawn(q(join(process.env.APPDATA ?? "", "npm", `${bin}.cmd`)), args.map(q), {
      timeout: timeoutMs,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // RUN THEM SOMEWHERE EMPTY. `kilo run` is an autonomous coding agent with file
      // tools, not a completion endpoint: spawned inside this repo it spent a whole
      // batch reading legs.ts and cli-legs.ts and returned zero scores, burning 22k
      // input tokens exploring a codebase nobody asked it about. An empty cwd gives it
      // nothing to wander into and makes the run deterministic.
      cwd: SANDBOX,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 8 * 1024 * 1024) child.kill();
    });
    child.on("error", (e) => reject(new Error(`${bin}: ${e.message.slice(0, 140)}`)));
    child.on("close", () => resolve(out));
  });
}

function buildPrompt(hunt: string, rows: { donor: string; summary: string }[]): string {
  const list = rows
    .map((r, i) => `${i + 1}. ${r.donor} — ${String(r.summary).replace(/^\w+:\s*/, "").slice(0, 80)}`)
    .join("\n");
  return (
    `Score each candidate 1-10 for usefulness to someone BUILDING "${hunt}". Consider indirect uses.\n` +
    `Output ONLY N:score lines, one per candidate. No prose.\n\n${list}`
  );
}

/**
 * Scores are LINE-ANCHORED and range-checked. A loose /(\d+):(\d+)/ matches timestamps,
 * durations, "1:1" inside prose, and the numbered candidate list in the echoed prompt --
 * which is how a first run produced "40/10" and "34/10" for a 1-10 scale and ranked two
 * pieces of noise at the top. Anything outside 1-10, or pointing past the batch, is not a
 * score and is dropped.
 */
const SCORE_SHAPES: readonly RegExp[] = [
  // 7:9 -- exactly what the prompt asks for.
  /^(\d{1,3})\s*:\s*(\d{1,2})$/,
  // 7. owner/repo: 9 -- what a model that heard "one line per candidate" as "numbered
  // list" actually emits. MEASURED, not hypothetical: ling-3.0-flash-fin-free returns
  // this shape and scored a 5-candidate probe perfectly (three real engines 10/10/10,
  // two planted decoys 1/1) while the single strict shape matched NONE of its lines.
  // A lane reads "ok=0 empty=1" for that, which is indistinguishable from a dead lane.
  // Still anchored at BOTH ends: the trailing `: <1-2 digits>$` is what keeps it off the
  // echoed prompt, whose lines end in prose.
  /^(\d{1,3})[.)]\s*\S.*?:\s*(\d{1,2})$/,
];

/** One line in, one validated score out, or null. The only place a score is recognised. */
export function readScoreLine(line: string, batchSize: number): { idx: number; score: number } | null {
  const t = line.trim();
  for (const re of SCORE_SHAPES) {
    const m = re.exec(t);
    if (m === null) continue;
    const idx = Number(m[1]);
    const score = Number(m[2]);
    // Range and index checks are the whole defence. Without them a loose pattern matched
    // the echoed prompt's numbered list and produced 40/10 and 34/10 on a 1-10 scale,
    // ranking two pieces of noise above everything real. Widening the SHAPE is safe only
    // because these two checks never widened.
    if (idx < 1 || idx > batchSize) continue;
    if (score < 1 || score > 10) continue;
    return { idx, score };
  }
  return null;
}

export function parseScores(txt: string, batchSize: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of txt.split("\n")) {
    const hit = readScoreLine(line, batchSize);
    if (hit !== null) out.set(hit.idx, hit.score);
  }
  return out;
}

/**
 * Pull the answer out of ANY of these CLIs' JSON streams without knowing its shape.
 *
 * Every one of them nests the text somewhere different -- kilo emits a top-level
 * `{type:"text", text}`, cline a `{type:"run_result", text}`, opencode a
 * `{part:{type:"text", text}}`. Hardcoding one shape is how the kilo lane reported
 * "0/40 empty" for two batches while the subprocess was exiting 0 with a perfectly good
 * answer in it. So: walk every JSON line, take every string field called `text`, and
 * keep the one with the MOST line-anchored N:score lines -- never the longest, because
 * the echoed prompt is longer than the answer and full of numbered lines.
 */
/**
 * How many lines look like a real 1-10 score line. Shares readScoreLine with the parser,
 * so a shape the parser accepts can never be a shape the harvester overlooks -- pick the
 * wrong string here and a perfectly good answer is discarded before parsing.
 * The bound is permissive because this only RANKS candidate strings; the batch-accurate
 * index check happens in parseScores.
 */
const scoreLines = (s: string): number =>
  s.split("\n").filter((l) => readScoreLine(l, 999) !== null).length;

function harvestText(raw: string): string {
  let best = "";
  let bestN = 0;
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      const n = scoreLines(v);
      if (n > bestN) {
        bestN = n;
        best = v;
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const x of Object.values(v)) visit(x);
    }
  };
  // Strip ANSI first. Piping a CLI to a file yields clean JSON lines, but spawning it
  // through a shell yields its full TUI stream -- colour codes and all -- so every
  // JSON.parse fails and a lane that exited 0 with a perfect answer reports "empty".
  // That is exactly what kilo did: 40/40 by hand, 0/40 through the runner.
  const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const line of clean.split("\n")) {
    if (line.trim() === "") continue;
    try {
      visit(JSON.parse(line));
    } catch {
      /* partial or non-JSON stream line */
    }
  }
  // Last resort: the scores may be sitting in plain text that never parsed as JSON.
  if (bestN === 0 && scoreLines(clean) > 0) return clean;
  return best;
}

async function main(): Promise<void> {
  // Before the --hunt guard: asking what is left must never require knowing a hunt name.
  if (BACKLOG) {
    reportBacklog();
    return;
  }
  if (HUNT === "") {
    process.stdout.write('triage: --hunt "<the hunt>" is required (or --backlog)\n');
    return;
  }
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const matching = readLoot().filter((r) => r.hunt === HUNT && isTriageable(r));
  const all = matching.slice(0, LIMIT);

  if (all.length === 0) {
    process.stdout.write(
      `triage: no rows for that hunt under ${TRIAGEABLE_RULE}\n` +
        `  run --backlog for the hunts that do have work\n`,
    );
    return;
  }

  const isHttp = (l: string): boolean => HTTP_LANE_SPECS[l] !== undefined;
  const lanes = LANES.filter((l) => isHttp(l) || LANE_SPECS[l] !== undefined);
  if (lanes.length === 0) {
    process.stdout.write(`triage: no usable lanes in "${LANES.join(",")}"\n`);
    return;
  }
  const work: Record<string, { donor: string; summary: string }[][]> = {};
  for (const l of lanes) work[l] = [];
  // HTTP lanes take a smaller batch: they are the ones that reason hardest, and a big
  // batch against a reasoning model is how you get an empty response that reads like a
  // crash. CLI lanes take the big batch because their ~33s startup is fixed per call and
  // only amortises across a large one.
  const size = (l: string) => (isHttp(l) ? Math.min(BATCH, HTTP_LANE_SPECS[l].batch) : BATCH);

  if (CONSENSUS) {
    // CONSENSUS: every candidate goes to EVERY lane. Twice the calls, but it is the only
    // mode that produces corroboration -- and corroboration is the thing the whole
    // discovery stack has been trying to manufacture. Two independent models both
    // scoring a candidate high is a far stronger signal than one model's 10, which the
    // first run showed can be a keyword match on "sort".
    for (const lane of lanes) {
      for (let j = 0; j < all.length; j += size(lane)) work[lane].push(all.slice(j, j + size(lane)));
    }
  } else {
    // THROUGHPUT (default): deal batches round-robin so every lane starts immediately and
    // a slow lane cannot hold the run -- wall clock is the slowest LANE, never the sum.
    // NOTE: in this mode the lanes score DISJOINT candidates, so there is no agreement to
    // measure. Scores are one model's opinion. Use --consensus when that matters.
    let i = 0;
    let turn = 0;
    while (i < all.length) {
      const lane = lanes[turn % lanes.length];
      const n = size(lane);
      work[lane].push(all.slice(i, i + n));
      i += n;
      turn += 1;
    }
  }

  // Say what is being LEFT, not just what is being taken. A run that silently stops at
  // --limit reads exactly like a run that finished the hunt; the same trap the memory
  // store hit when a default page size passed for the whole answer.
  const remaining = matching.length - all.length;
  process.stdout.write(
    `TRIAGE  hunt="${HUNT.slice(0, 46)}"\n` +
      `  rows ${all.length} of ${matching.length} triageable` +
      (remaining > 0 ? `  (--limit leaves ${remaining} for a later run)` : `  (the whole hunt)`) +
      `\n  lanes ${lanes.join(", ")}\n` +
      lanes.map((l) => `    ${l.padEnd(6)} ${work[l].length} batches of ${size(l)}`).join("\n") +
      "\n\n",
  );
  if (DRY) {
    process.stdout.write("  --dry: planned only, nothing called\n");
    return;
  }

  const t0 = Date.now();
  // EVERY observation is kept, stamped with the lane that produced it. The old
  // Map<donor, score> let the last writer win, which silently threw away exactly the
  // disagreement worth knowing about -- and made "555 scored" a count of survivors
  // rather than of work done.
  const obs: { donor: string; lane: string; score: number }[] = [];

  const laneRuns = lanes.map(async (lane) => {
    let ok = 0;
    let fail = 0;
    for (const batch of work[lane]) {
      const prompt = buildPrompt(HUNT, batch);
      try {
        let txt: string;
        if (isHttp(lane)) txt = await httpBatch(lane, prompt);
        else {
          const spec = LANE_SPECS[lane];
          const f = join(SCRATCH, `${lane}-${Date.now()}.txt`);
          writeFileSync(f, prompt, "utf-8");
          txt = spec.parse(await runCli(spec.bin, spec.argv(f, prompt), 280_000));
        }
        const scores = parseScores(txt, batch.length);
        for (const [n, s] of scores) {
          const row = batch[n - 1];
          if (row) obs.push({ donor: row.donor, lane, score: s });
        }
        scores.size > 0 ? (ok += 1) : (fail += 1);
        process.stdout.write(`  ${lane.padEnd(6)} batch ok=${ok} empty=${fail}  observations=${obs.length}\n`);
      } catch (e) {
        fail += 1;
        process.stdout.write(`  ${lane.padEnd(6)} FAILED: ${String((e as Error).message).slice(0, 90)}\n`);
      }
    }
    return { lane, ok, fail };
  });

  const results = await Promise.all(laneRuns);
  const ms = Date.now() - t0;
  const out = join(OUT_DIR, "triage.jsonl");
  const stamp = Date.now();
  for (const o of obs) {
    appendFileSync(out, `${JSON.stringify({ ts: stamp, hunt: HUNT, donor: o.donor, lane: o.lane, score: o.score })}\n`);
  }

  // Fold observations into a verdict per donor.
  const byDonor = new Map<string, { lane: string; score: number }[]>();
  for (const o of obs) byDonor.set(o.donor, [...(byDonor.get(o.donor) ?? []), o]);

  const folded = [...byDonor.entries()].map(([donor, v]) => {
    const scores = v.map((x) => x.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    return {
      donor,
      lanes: v.length,
      min,
      max,
      spread: max - min,
      // The floor, not the mean. A candidate is only as good as the LEAST impressed
      // model that looked at it: averaging lets one keyword match drag noise to the top,
      // which is how sort-asc and sort-object reached 10/10 for a dependency planner.
      floor: min,
    };
  });

  const agreed = folded.filter((f) => f.lanes > 1 && f.floor >= 8).sort((a, b) => b.floor - a.floor || a.spread - b.spread);
  const single = folded.filter((f) => f.lanes === 1).sort((a, b) => b.max - a.max);
  const contested = folded.filter((f) => f.lanes > 1 && f.spread >= 5).sort((a, b) => b.spread - a.spread);

  const line = (f: { donor: string; min: number; max: number; lanes: number }) =>
    `  ${String(f.min).padStart(2)}-${String(f.max).padEnd(2)}  ${String(f.lanes)} lane${f.lanes > 1 ? "s" : " "}  ${f.donor}`;

  // A --consensus run that loses a lane silently becomes a throughput run. Every donor
  // lands lanes:1, the AGREED filter (lanes>1) matches nothing, and the report prints
  // "none" -- which reads as "both models looked and shortlisted nothing" when the truth
  // is "only one model ever spoke". MEASURED: cline returned no scores mid-run and the
  // summary announced AGREED none / CONTESTED none over 40 perfectly good scores. The
  // lane tally four lines above said ok=0 and the summary still misled. Name it instead.
  const answering = new Set(obs.map((o) => o.lane));
  const degraded = CONSENSUS && answering.size < 2;

  process.stdout.write(
    `\nDONE  ${obs.length} observations over ${byDonor.size} donors of ${all.length} rows, ${(ms / 1000 / 60).toFixed(1)} min\n` +
      results.map((r) => `  ${r.lane.padEnd(6)} ok=${r.ok} failed=${r.fail}`).join("\n") +
      (degraded
        ? `\n\n!!  NO CORROBORATION — --consensus asked ${lanes.length} lanes, ${answering.size} answered` +
          ` (${answering.size === 0 ? "none" : [...answering].join(", ")}).\n` +
          `    Every score below is ONE model's unverified opinion. AGREED is empty because\n` +
          `    nothing had a second lane to agree WITH, not because nothing scored well.\n` +
          `    Re-run with a second tier-1 lane before trusting any ranking from this.\n` +
          `\nTOP 15 — single lane, uncorroborated:\n${single.slice(0, 15).map(line).join("\n")}\n`
        : CONSENSUS
          ? `\n\nAGREED — every lane scored it 8+ (${agreed.length}). This is the shortlist:\n` +
            (agreed.length === 0 ? "  none\n" : `${agreed.slice(0, 15).map(line).join("\n")}\n`) +
            `\nCONTESTED — lanes disagree by 5+ (${contested.length}). Read these yourself:\n` +
            (contested.length === 0 ? "  none\n" : `${contested.slice(0, 8).map(line).join("\n")}\n`)
          : `\n\nTOP 15 — ONE lane's opinion each, no corroboration (use --consensus for that):\n` +
            `${single.slice(0, 15).map(line).join("\n")}\n`) +
      `\nwritten: ${out}\n`,
  );
}

// Only run when invoked directly. triage-smoke.ts imports the parser from here, and an
// unguarded main() would fire a triage run just for importing a pure function.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    process.stdout.write(`triage: ${String((e as Error).message).slice(0, 200)}\n`);
  });
}
