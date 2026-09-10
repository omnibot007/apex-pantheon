// triage.ts — score a loot ledger across independent quota lanes.
//
// The job: 4,982 triageable rows in apex-memory's loot ledger -- unseen, and carrying a
// summary a model can actually judge -- harvested and labelled by omnithief and never
// read by anything. Deterministic labels got them into the vault; only a model can put
// them in a useful order. (The ledger holds ~12,000 rows total; the rest are already
// judged or have no usable summary. "8,137" was quoted for a while and was wrong.)
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
//   node triage.ts --hunt "<hunt>" [--limit 400] [--batch 40] [--lanes cline,go]
//   node triage.ts --hunt "<hunt>" --consensus     every lane scores every candidate
//   node triage.ts --hunt "<hunt>" --dry            plan only, no calls
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
/** Send every candidate to EVERY lane, so agreement between them is measurable. */
const CONSENSUS = process.argv.includes("--consensus");
const HUNT = arg("hunt", "");
const LIMIT = Number(arg("limit", "400"));
const BATCH = Number(arg("batch", "40"));
const LANES = arg("lanes", "cline,go").split(",").map((s) => s.trim());

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

/** The Go lane is HTTP, not a subprocess -- no startup tax, so it uses a smaller batch. */
async function goBatch(prompt: string): Promise<string> {
  const { buildPool } = await import("./legs.ts");
  buildPool("triage");
  const key = process.env.OPENCODE_GO_KEY;
  if (!key) throw new Error("OPENCODE_GO_KEY not loaded");
  const r = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "User-Agent": "fam-gods/1.0",
      "x-opencode-session": `triage-${Date.now()}`,
    },
    // 8000, not 3000: this model spends thousands of tokens reasoning before it answers.
    body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: prompt }], max_tokens: 8000 }),
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
function parseScores(txt: string, batchSize: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of txt.split("\n")) {
    const m = /^\s*(\d{1,3})\s*:\s*(\d{1,2})\s*$/.exec(line.trim());
    if (m === null) continue;
    const idx = Number(m[1]);
    const score = Number(m[2]);
    if (idx < 1 || idx > batchSize) continue;
    if (score < 1 || score > 10) continue;
    out.set(idx, score);
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
/** How many lines look like a real 1-10 score line. */
const scoreLines = (s: string): number =>
  s.split("\n").filter((l) => /^\s*\d{1,3}\s*:\s*(?:10|[1-9])\s*$/.test(l.trim())).length;

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
  if (HUNT === "") {
    process.stdout.write('triage: --hunt "<the hunt>" is required\n');
    return;
  }
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const all = readFileSync(LOOT, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { donor: string; hunt: string; summary: string; verdict: string })
    .filter((r) => r.hunt === HUNT && r.verdict === "unseen" && String(r.summary ?? "").length > 25)
    .slice(0, LIMIT);

  if (all.length === 0) {
    process.stdout.write(`triage: no unseen rows with a usable summary for that hunt\n`);
    return;
  }

  const HTTP_LANES = new Set(["go"]);
  const lanes = LANES.filter((l) => HTTP_LANES.has(l) || LANE_SPECS[l] !== undefined);
  const work: Record<string, { donor: string; summary: string }[][]> = {};
  for (const l of lanes) work[l] = [];
  // go uses a smaller batch: it is the metered lane and the one that reasons hardest.
  const size = (l: string) => (l === "go" ? Math.min(BATCH, 20) : BATCH);

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

  process.stdout.write(
    `TRIAGE  hunt="${HUNT.slice(0, 46)}"\n  rows ${all.length}  lanes ${lanes.join(", ")}\n` +
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
        if (lane === "go") txt = await goBatch(prompt);
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

  process.stdout.write(
    `\nDONE  ${obs.length} observations over ${byDonor.size} donors of ${all.length} rows, ${(ms / 1000 / 60).toFixed(1)} min\n` +
      results.map((r) => `  ${r.lane.padEnd(6)} ok=${r.ok} failed=${r.fail}`).join("\n") +
      (CONSENSUS
        ? `\n\nAGREED — every lane scored it 8+ (${agreed.length}). This is the shortlist:\n` +
          (agreed.length === 0 ? "  none\n" : `${agreed.slice(0, 15).map(line).join("\n")}\n`) +
          `\nCONTESTED — lanes disagree by 5+ (${contested.length}). Read these yourself:\n` +
          (contested.length === 0 ? "  none\n" : `${contested.slice(0, 8).map(line).join("\n")}\n`)
        : `\n\nTOP 15 — ONE lane's opinion each, no corroboration (use --consensus for that):\n` +
          `${single.slice(0, 15).map(line).join("\n")}\n`) +
      `\nwritten: ${out}\n`,
  );
}

main().catch((e: unknown) => {
  process.stdout.write(`triage: ${String((e as Error).message).slice(0, 200)}\n`);
});
