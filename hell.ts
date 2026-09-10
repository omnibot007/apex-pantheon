// hell.ts — the trial by fire, and the config selector in one.
//
// legs-smoke asks every leg for one tiny completion. That proves a leg is ALIVE. It does
// not prove the leg is USEFUL, and the difference is where this pool was leaking:
//
//   * `// Order = cheap-first` is meaningless when every model in the pool is declared
//     `cost: 0`. Ordering by a constant means the pool answers with whatever happens to
//     sit first -- which today is `nemotron-3.5-lightning`, the smallest thing in it.
//   * `nvidia/nemotron-3-ultra-550b-a55b:free` is configured, proven working in
//     telemetry, and STRUCTURALLY UNREACHABLE: first clean completion wins, and two
//     models sit ahead of it.
//   * Four models with proven successes in telemetry are not in the config at all --
//     groq/llama-3.3-70b-versatile, cerebras/llama-3.3-70b, pollinations/openai-large,
//     tokenrouter/z-ai/glm-5.3-free.
//
// So price cannot rank this pool. CAPABILITY has to, and capability has to be measured.
// Each model runs a battery aimed at the jobs this pool is actually for: following an
// exact format, emitting parseable JSON, judging a repo blurb, and not looping.
//
// Usage:
//   node hell.ts                 every configured + candidate model, full battery
//   node hell.ts --quick         liveness + format only
//   node hell.ts --only groq     substring filter on leg id
//
// Secrets: keys resolve from files inside legs.ts. Nothing here reads, prints or logs a
// key value -- only leg ids and model ids.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, envApiKeyAuth, type Context, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { BUILTIN_SPECS, buildPool } from "./legs.ts";

const QUICK = process.argv.includes("--quick");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  return i === -1 ? null : process.argv[i + 1];
})();

const ATTEMPT_MS = 75_000;
const PACE_MS = 1_500; // free tiers run 20-30 RPM; do not hammer what you depend on

interface Trial {
  name: string;
  prompt: string;
  /** Returns null on pass, or the reason it failed. */
  judge: (text: string) => string | null;
  weight: number;
}

const nonEmpty = (t: string) => (t.trim().length === 0 ? "empty output" : null);

/** Longest run of one repeated line — SIMURG watches for this class, so the pool should too. */
function loopiness(text: string): number {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let best = 1;
  let run = 1;
  for (let i = 1; i < lines.length; i += 1) {
    run = lines[i] === lines[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

const TRIALS: Trial[] = [
  {
    name: "live",
    prompt: "Reply with exactly: legs-ready",
    judge: (t) => (t.toLowerCase().includes("legs-ready") ? null : `no marker, got "${t.slice(0, 40)}"`),
    weight: 1,
  },
  {
    name: "format",
    // The pool's whole job for King G is terse structured triage. A model that cannot
    // hold a two-word format cannot be trusted with a ranking.
    prompt: "Answer with ONLY the single word YES or NO, no punctuation, no explanation. Is the sky blue?",
    judge: (t) => {
      const w = t.trim().replace(/[^a-z]/gi, "").toUpperCase();
      return w === "YES" || w === "NO" ? null : `did not hold format: "${t.trim().slice(0, 50)}"`;
    },
    weight: 3,
  },
  {
    name: "json",
    prompt:
      'Output ONLY valid JSON, no markdown fence, no prose, exactly this shape: {"score":<1-10 integer>,"why":"<8 words max>"} rating how relevant a DAG-rendering library is to a task planner.',
    judge: (t) => {
      const raw = t.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const start = raw.indexOf("{");
      if (start === -1) return `no JSON object: "${raw.slice(0, 50)}"`;
      try {
        const o = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1));
        if (typeof o.score !== "number") return "score is not a number";
        if (typeof o.why !== "string") return "why is not a string";
        return null;
      } catch (e) {
        return `unparseable: ${String(e).slice(0, 50)}`;
      }
    },
    weight: 5,
  },
  {
    name: "triage",
    // The actual job: judge a repo blurb against a hunt. This is the King G bridge.
    prompt:
      'Hunt: "a planner that orders build steps by dependency".\n' +
      'Repo: "ascii-dag — Lightweight ASCII DAG renderer for error chains, build systems, and dependency visualization."\n' +
      "Is this relevant to the hunt? Reply with ONLY one word: RELEVANT or IRRELEVANT.",
    judge: (t) => {
      const w = t.toUpperCase();
      if (w.includes("IRRELEVANT")) return "called a DAG renderer irrelevant to a dependency planner";
      return w.includes("RELEVANT") ? null : `no verdict: "${t.trim().slice(0, 50)}"`;
    },
    weight: 5,
  },
  {
    name: "long-in",
    prompt: `Summarise in EXACTLY one sentence.\n\n${"The build system invalidates a cached target when any of its inputs change. ".repeat(90)}`,
    judge: (t) => {
      const e = nonEmpty(t);
      if (e) return e;
      return t.length > 1200 ? "ignored the one-sentence cap" : null;
    },
    weight: 2,
  },
  {
    name: "no-loop",
    prompt: "List 5 distinct dependency-ordering algorithms, one per line, names only.",
    judge: (t) => {
      const e = nonEmpty(t);
      if (e) return e;
      const l = loopiness(t);
      return l >= 3 ? `looped: same line ${l}x in a row` : null;
    },
    weight: 3,
  },
  {
    name: "no-refuse",
    // Free tiers are often over-tuned. A model that refuses benign engineering work is
    // useless here regardless of how big it is.
    prompt: "Explain in two sentences how a circuit breaker prevents cascading failure in a request pool.",
    judge: (t) => {
      const e = nonEmpty(t);
      if (e) return e;
      return /\b(i cannot|i can't|i'm unable|as an ai|i am not able)\b/i.test(t)
        ? `refused benign request: "${t.slice(0, 60)}"`
        : null;
    },
    weight: 2,
  },
];

const battery = QUICK ? TRIALS.filter((t) => t.name === "live" || t.name === "format") : TRIALS;

/** Candidate models NOT in legs.ts today: proven in telemetry, or free on the catalogue. */
const CANDIDATES: Record<string, { baseUrl: string; keyEnv: string | null; models: string[] }> = {
  "openrouter-free": {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    models: [
      "nvidia/nemotron-3-super-120b-a12b:free",
      "thinkingmachines/inkling:free",
      "nex-agi/nex-n2.5-pro:free",
      "google/gemma-4-31b-it:free",
      "poolside/laguna-s-2.1:free",
      "dots-studio/dots-3-note-preview:free",
    ],
  },
  zen: { baseUrl: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_GO_KEY", models: ["deepseek-v4-pro","deepseek-v4-flash-free","deepseek-v4-flash","qwen3.8-flash","gpt-5.6-luna"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", models: ["llama-3.3-70b-versatile"] },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", models: ["llama-3.3-70b"] },
  pollinations: { baseUrl: "https://gen.pollinations.ai/v1", keyEnv: "POLLINATIONS_API_KEY", models: ["openai-large"] },
};

function candidateProvider(id: string, spec: { baseUrl: string; keyEnv: string | null; models: string[] }) {
  return createProvider({
    id: `${id}-cand`,
    name: `${id}-cand`,
    baseUrl: spec.baseUrl,
    auth: spec.keyEnv
      ? { apiKey: envApiKeyAuth(`${id} key`, [spec.keyEnv]) }
      : { apiKey: { name: id, resolve: async () => ({ auth: {} }) } },
    models: spec.models.map(
      (mid): Model<"openai-completions"> => ({
        id: mid,
        name: mid,
        api: "openai-completions",
        provider: `${id}-cand`,
        baseUrl: spec.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 1024,
      }),
    ),
    api: openAICompletionsApi(),
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout-after-${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SESSION = `hell-${Date.now()}`;
const pool = buildPool(SESSION);
for (const [id, spec] of Object.entries(CANDIDATES)) pool.models.setProvider(candidateProvider(id, spec));

interface Row {
  leg: string;
  model: string;
  provider: string;
  alive: boolean;
  score: number;
  max: number;
  pct: number;
  ms: number;
  passed: string[];
  attempted: number;
  infra: number;
  failed: { trial: string; why: string; kind?: string }[];
  deadReason?: string;
}

const targets: { leg: string; provider: string; model: string }[] = [];
for (const l of pool.legs) for (const m of l.models) targets.push({ leg: l.id, provider: l.id, model: m });
for (const [id, spec] of Object.entries(CANDIDATES))
  for (const m of spec.models) targets.push({ leg: id, provider: `${id}-cand`, model: m });

const filtered = ONLY ? targets.filter((t) => t.leg.includes(ONLY)) : targets;

const OUT_DIR = join(homedir(), ".commandcode", "fam-gods");
mkdirSync(OUT_DIR, { recursive: true });
const OUT = join(OUT_DIR, "hell.jsonl");
writeFileSync(OUT, "");

process.stdout.write(
  `HELL — ${filtered.length} models x ${battery.length} trials  (session ${SESSION})\n` +
    `writing ${OUT}\n\n`,
);

const rows: Row[] = [];

for (const t of filtered) {
  const model = pool.models.getModel(t.provider, t.model);
  const label = `${t.leg}/${t.model}`;
  if (!model) {
    rows.push({ leg: t.leg, model: t.model, provider: t.provider, alive: false, score: 0, max: 0, pct: 0, ms: 0, passed: [], attempted: 0, infra: 0, failed: [], deadReason: "not-registered" });
    process.stdout.write(`  ${label.padEnd(52)} not-registered\n`);
    continue;
  }

  const row: Row = { leg: t.leg, model: t.model, provider: t.provider, alive: false, score: 0, max: 0, pct: 0, ms: 0, passed: [], attempted: 0, infra: 0, failed: [] };
  const started = Date.now();

  for (const trial of battery) {
    row.max += trial.weight;
    const context: Context = { messages: [{ role: "user", content: trial.prompt, timestamp: Date.now() }], tools: [] };
    try {
      const res = await withTimeout(
        pool.models.completeSimple(model, context, {
          transformHeaders: async (h) => {
            if (t.leg === "go" || t.leg === "zenfree")
              return { ...h, "x-opencode-session": SESSION, "User-Agent": "fam-gods/1.0" };
            if (t.leg === "kilo-anon")
              return { ...h, "cf-aig-authorization": "anonymous", Authorization: null as unknown as string };
            return h;
          },
        }),
        ATTEMPT_MS,
      );
      if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(`stopReason=${res.stopReason}`);
      const text = res.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
      row.alive = true;
      row.attempted += trial.weight;
      const verdict = trial.judge(text);
      if (verdict === null) { row.score += trial.weight; row.passed.push(trial.name); }
      else row.failed.push({ trial: trial.name, why: verdict, kind: "judge" });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
      // AVAILABILITY is not CAPABILITY, and scoring them together is how you bench a
      // strong model for being busy and promote a weak one for being reachable.
      // Measured: the 550B threw stopReason=error on three trials and scored 57%, while
      // four 27B-class models answered every time and called a DAG renderer IRRELEVANT
      // to a dependency planner -- the exact judgement this pool exists to make.
      // Infra failures do not count against capability; they count against uptime.
      row.failed.push({ trial: trial.name, why: msg, kind: "infra" });
      row.infra += 1;
      // Stop burning the battery on a corpse. A model that has not produced ONE clean
      // completion after two attempts is dead or unconfigured, and every further trial
      // is 75s of timeout against a free tier we depend on staying friendly.
      if (!row.alive && row.failed.length >= 2) {
        row.deadReason = msg;
        break;
      }
    }
    await sleep(PACE_MS);
  }

  row.ms = Date.now() - started;
  row.pct = row.attempted === 0 ? 0 : Math.round((row.score / row.attempted) * 100);
  rows.push(row);
  appendFileSync(OUT, `${JSON.stringify({ ts: Date.now(), ...row })}\n`);

  const verdict = !row.alive ? (row.deadReason ? "DEAD" : "no-completion") : `${row.pct}%`;
  process.stdout.write(
    `  ${label.padEnd(52)} ${String(verdict).padStart(6)}  ${row.passed.join(",") || "-"}` +
      `${row.failed.length > 0 && row.alive ? `   FAILED: ${row.failed.map((f) => f.trial).join(",")}` : ""}\n`,
  );
}

const live = rows.filter((r) => r.alive).sort((a, b) => b.pct - a.pct || a.ms - b.ms);
process.stdout.write(
  `\n${"=".repeat(74)}\nCAPABILITY ORDER — this is the order legs.ts should use, price is constant\n${"=".repeat(74)}\n`,
);
for (const r of live) {
  process.stdout.write(
    `  ${String(r.pct).padStart(3)}%  ${String(Math.round(r.ms / 1000) + "s").padStart(5)}  ${`${r.leg}/${r.model}`.padEnd(52)}` +
      `${r.failed.length > 0 ? ` (fails: ${r.failed.map((f) => f.trial).join(",")})` : ""}\n`,
  );
}
const dead = rows.filter((r) => !r.alive);
if (dead.length > 0) {
  process.stdout.write(`\nDEAD OR UNCONFIGURED (${dead.length}) — rotation skips these:\n`);
  for (const r of dead) process.stdout.write(`  ${`${r.leg}/${r.model}`.padEnd(52)} ${(r.deadReason ?? r.failed[0]?.why ?? "no completion").slice(0, 60)}\n`);
}
process.stdout.write(`\nlive=${live.length}  dead=${dead.length}  full log: ${OUT}\n`);

/**
 * Close the loop: measurement WRITES the roster.
 *
 * Legs are ordered by their best surviving model, models within a leg by capability then
 * latency. Anything that failed to complete is kept with `enabled:false` and the reason,
 * never deleted -- a model that died today often returns, and the reason it was benched
 * is the part you cannot reconstruct later.
 */
if (process.argv.includes("--write-config")) {
  const best = new Map<string, Row>();
  for (const r of live) {
    const cur = best.get(r.leg);
    if (!cur || r.pct > cur.pct || (r.pct === cur.pct && r.ms < cur.ms)) best.set(r.leg, r);
  }

  const byId = new Map(BUILTIN_SPECS.map((s) => [s.id, s]));
  for (const [id, spec] of Object.entries(CANDIDATES)) {
    if (!byId.has(id)) byId.set(id, { id, name: id, baseUrl: spec.baseUrl, keyEnv: spec.keyEnv, maxTokens: 1024, models: [] });
  }

  const legOrder = [...best.entries()]
    .sort((a, b) => b[1].pct - a[1].pct || a[1].ms - b[1].ms)
    .map(([id]) => id);
  for (const r of rows) if (!legOrder.includes(r.leg)) legOrder.push(r.leg);

  const out = {
    _note: "Generated by `node hell.ts --write-config`. legs.ts reads this and falls back to BUILTIN_SPECS if it is missing or malformed, so deleting it cannot break the pool.",
    _ordering: "CAPABILITY then LATENCY. Every model is cost:0, so price ranks nothing -- the old cheap-first comment sorted a constant and the pool always answered with whatever sat first.",
    _disabled: "enabled:false keeps a model documented but out of rotation, with the reason it was benched.",
    version: 1,
    generatedAt: new Date().toISOString(),
    battery: battery.map((t) => t.name),
    legs: legOrder.map((legId) => {
      const spec = byId.get(legId);
      const mine = rows.filter((r) => r.leg === legId);
      const models = mine
        .sort((a, b) => Number(b.alive) - Number(a.alive) || b.pct - a.pct || a.ms - b.ms)
        .map((r) => ({
          id: r.model,
          ...(r.alive ? {} : { enabled: false }),
          pct: r.pct,
          ms: r.ms,
          ...(r.alive
            ? r.failed.length > 0
              ? { why: `fails: ${r.failed.map((f) => f.trial).join(",")}` }
              : {}
            : { why: (r.deadReason ?? r.failed[0]?.why ?? "no completion").slice(0, 120) }),
        }));
      return {
        id: legId,
        name: spec?.name ?? legId,
        baseUrl: spec?.baseUrl ?? "",
        keyEnv: spec?.keyEnv ?? null,
        maxTokens: spec?.maxTokens ?? 4096,
        models,
      };
    }),
  };

  const target = new URL("./legs.config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  const enabled = out.legs.flatMap((l) => l.models.filter((m) => (m as { enabled?: boolean }).enabled !== false));
  process.stdout.write(
    `\nwrote ${target}\n  legs ${out.legs.length}  models ${enabled.length} enabled / ${out.legs.flatMap((l) => l.models).length} total\n` +
      `  new failover order: ${legOrder.join(" -> ")}\n`,
  );
}
