// fam-gods legs — free-model pool with failover rotation + spend telemetry.
// Patterns owned by pi-ai (MIT (c) 2025 Mario Zechner): createProvider,
// openAICompletionsApi, envApiKeyAuth, per-message usage.cost, transformHeaders.
// Go key arrives via file (never chat): FAM_GO_KEY_FILE -> process env.
// Session contract (verified live 2026-09-09): stable x-opencode-session per
// conversation + real User-Agent, or the edge 403s / the gateway 400s.
import { readFileSync } from "node:fs";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

const GO_BASE = "https://opencode.ai/zen/go/v1"; // impl appends /chat/completions

/** Every env name the loader will populate from a key file. A leg naming anything
 * outside this set can never authenticate. */
const LOADED_ENV = new Set(["OPENCODE_GO_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY", "POLLINATIONS_API_KEY"]);

function fileKeyEnv(varName: string, filePath: string): void {
  if (!process.env[varName]) {
    try {
      process.env[varName] = readFileSync(filePath, "utf-8").trim();
    } catch {
      /* leg stays unconfigured; rotation skips it */
    }
  }
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const FREE: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Two API shapes live behind one key.
 *
 * OpenCode Go serves `deepseek-flash` and the GLM/Kimi family on
 * `/chat/completions`, but `muse-spark-*-contributor` on `/responses` -- a different
 * wire format, not a different base URL. Hardcoding openAICompletionsApi() made the
 * highest-volume model on the plan (Muse Spark 1.3 Contributor, 45,300 requests per
 * 5 hours) unreachable no matter what id was configured.
 */
type ApiKind = "openai-completions" | "openai-responses";

function leg(
  id: string,
  name: string,
  baseUrl: string,
  keyEnv: string | null,
  models: { id: string; cost?: ModelCost }[],
  maxTokens = 4096, // free tiers cap output/min — groq on_demand allows 1000 OTPM
  apiKind: ApiKind = "openai-completions",
): { id: string; provider: ReturnType<typeof createProvider>; models: string[] } {
  const provider = createProvider({
    id,
    name,
    baseUrl,
    auth: keyEnv
      ? { apiKey: envApiKeyAuth(`${name} key`, [keyEnv]) }
      : { apiKey: { name, resolve: async () => ({ auth: {} }) } },
    models: models.map(
      (m): Model<ApiKind> => ({
        id: m.id,
        name: `${name} ${m.id}`,
        api: apiKind,
        provider: id,
        baseUrl,
        reasoning: false,
        input: ["text"],
        // Dollars per 1M tokens (pi-ai: rates.input / 1_000_000 * usage.input).
        // Real rates for metered models, so telemetry stops reporting $0 for a paid call.
        cost: m.cost ?? FREE,
        contextWindow: 64000,
        maxTokens,
      }),
    ),
    api: apiKind === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
  });
  return { id, provider, baseUrl, models: models.map((m) => m.id) };
}

export interface PoolLeg extends ReturnType<typeof leg> {
  session: string;
}

export interface LegConfigEntry {
  id: string;
  name: string;
  baseUrl: string;
  keyEnv: string | null;
  maxTokens?: number;
  api?: "openai-completions" | "openai-responses";
  models: { id: string; enabled?: boolean; tier?: number; pct?: number; ms?: number; why?: string; cost?: ModelCost }[];
}

/**
 * The roster as DATA, when it exists.
 *
 * `buildPool` used to hardcode the pool, which meant tuning it required editing failover
 * logic -- so nobody tuned it, and it drifted: two models with proven telemetry successes
 * were absent, five configured models had never once completed, and the strongest model
 * in the pool sat third inside the second leg where first-clean-wins could never reach it.
 *
 * A missing or malformed config falls back to the built-in defaults, so deleting this
 * file can never take the pool down.
 */
function loadConfig(): LegConfigEntry[] | null {
  const path = process.env.FAM_LEGS_CONFIG ?? new URL("./legs.config.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { legs?: LegConfigEntry[] };
    if (!Array.isArray(raw.legs) || raw.legs.length === 0) return null;
    return raw.legs;
  } catch {
    return null;
  }
}

export function buildPool(sessionId: string) {
  const kf = (name: string) =>
    process.env[name.toUpperCase()] ??
    join(homedir(), ".config", "opencode", `.${name}-key`);
  fileKeyEnv("OPENCODE_GO_KEY", process.env.FAM_GO_KEY_FILE ?? kf("go"));
  // POLLINATIONS_API_KEY was demanded by a leg and loaded by nothing, so that leg could
  // never authenticate no matter what key existed -- it read as a quota failure for weeks.
  // Any env name a leg names must appear here or the leg is dead by construction.
  for (const k of LOADED_ENV) {
    fileKeyEnv(k, process.env[`FAM_${k.replace("_API_KEY", "")}_KEY_FILE`] ?? kf(k.toLowerCase().replace("_api_key", "")));
  }
  const models = createModels();
  const legs: PoolLeg[] = [];
  const add = (l: ReturnType<typeof leg>) => {
    models.setProvider(l.provider);
    legs.push({ ...l, session: sessionId });
  };

  // Config wins when present. Order in the file IS the failover order.
  // Every keyEnv a leg demands must be loadable, or that leg is dead by construction and
  // reads as a quota failure. Cheap assertion, caught a real one.
  const demanded = new Set(BUILTIN_SPECS.map((s) => s.keyEnv).filter((k): k is string => k !== null));
  const unloadable = [...demanded].filter((k) => !LOADED_ENV.has(k));
  if (unloadable.length > 0) {
    process.emitWarning(`legs: keyEnv demanded but never loaded from file: ${unloadable.join(", ")}`);
  }

  const configured = loadConfig();
  if (configured !== null) {
    for (const entry of configured) {
      const live = entry.models.filter((m) => m.enabled !== false).map((m) => ({ id: m.id, ...(m.cost ? { cost: m.cost } : {}) }));
      if (live.length === 0) continue; // every model benched: skip the leg entirely
      add(leg(entry.id, entry.name, entry.baseUrl, entry.keyEnv, live, entry.maxTokens ?? 4096, entry.api ?? "openai-completions"));
    }
    if (legs.length > 0) return { models, legs };
  }

  for (const s of BUILTIN_SPECS) add(leg(s.id, s.name, s.baseUrl, s.keyEnv, s.models.map((m) => ({ id: m.id, ...(m.cost ? { cost: m.cost } : {}) })), s.maxTokens, s.api ?? "openai-completions"));
  return { models, legs };
}

/**
 * The built-in roster — the fallback when no config file is present, and the single
 * source of connection details that `hell.ts --write-config` uses to emit one.
 *
 * Kilo anonymous: unauthenticated `:free` only, 200 req/hr/IP. Base URL WITHOUT
 * /chat/completions (the impl appends it), keyless so keyEnv is null.
 * Pollinations now requires a free key: https://enter.pollinations.ai/keys
 * OVH anonymous trickle: 2 RPM/IP, EU, output capped per anon limits.
 * Zen free lane rides the SAME Go key (verified: 7 free variants live there).
 */
export const BUILTIN_SPECS: LegConfigEntry[] = [
  { id: "kilo-anon", name: "KiloAnon", baseUrl: "https://api.kilo.ai/api/gateway", keyEnv: null, maxTokens: 4096,
    models: [{ id: "nvidia/nemotron-3.5-lightning:free" }] },
  { id: "openrouter-free", name: "OpenRouterFree", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", maxTokens: 4096,
    models: [
      { id: "nvidia/nemotron-3.5-lightning:free" },
      { id: "cohere/north-mini-code:free" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
      { id: "nex-agi/nex-n2.5-pro:free" },
      { id: "dots-studio/dots-3-note-preview:free" },
      { id: "nvidia/nemotron-3-super-120b-a12b:free" },
    ] },
  { id: "pollinations", name: "Pollinations", baseUrl: "https://gen.pollinations.ai/v1", keyEnv: "POLLINATIONS_API_KEY", maxTokens: 4096,
    models: [{ id: "openai/gpt-5.4-nano" }] },
  { id: "ovh", name: "OVHAnon", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", keyEnv: null, maxTokens: 1024,
    models: [{ id: "gpt-oss-120b" }] },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", maxTokens: 800,
    models: [{ id: "qwen/qwen3.8-27b" }] },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY", maxTokens: 800,
    models: [{ id: "qwen-3.8-27b" }] },
  { id: "go", name: "GoFallback", baseUrl: GO_BASE, keyEnv: "OPENCODE_GO_KEY", maxTokens: 4096,
    models: [{ id: "deepseek-v4-flash" }, { id: "glm-5.3-flash" }] },
  { id: "zenfree", name: "ZenFree", baseUrl: "https://opencode.ai/zen/v1", keyEnv: "OPENCODE_GO_KEY", maxTokens: 4096,
    models: [
      { id: "nemotron-3.5-lightning-free" },
      { id: "mimo-v2.5-free" },
      { id: "ling-3.0-flash-fin-free" },
      { id: "nemotron-3-ultra-free" },
    ] },
];

export interface LegResult {
  leg: string;
  model: string;
  text: string;
  cost: number;
}

/** Any leg pointed at opencode.ai must send the session contract, whatever it is called. */
function isOpenCodeHost(l: { baseUrl?: string; id: string }): boolean {
  return typeof l.baseUrl === "string" && l.baseUrl.includes("opencode.ai");
}

const TELE_MAX_BYTES = 5 * 1024 * 1024;

function tele(record: object): void {
  const dir = join(homedir(), ".commandcode", "fam-gods");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "legs.jsonl");
  try {
    const st = statSync(p);
    if (st.size > TELE_MAX_BYTES) renameSync(p, p + ".1");
  } catch {
    /* first write */
  }
  appendFileSync(p, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
}

// Circuit breaker: legs failing repeatedly sit out (fail-fast for the pool).
const breaker = new Map<string, number>();
const BREAKER_TRIPS_AT = 3;
const ATTEMPT_TIMEOUT_MS = 90000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout-after-${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Ordered failover across legs/models. First clean completion wins.
 *  Go-bound requests carry the session contract via transformHeaders. */
export async function completeWithFailover(
  pool: ReturnType<typeof buildPool>,
  messages: { role: "user"; content: string; timestamp: number }[],
  tried: string[] = [],
): Promise<LegResult> {
  const failures: string[] = [];
  for (const l of pool.legs) {
    if ((breaker.get(l.id) ?? 0) >= BREAKER_TRIPS_AT) {
      failures.push(`${l.id}: breaker-open (3 straight fails, sitting out)`);
      continue;
    }
    for (const mid of l.models) {
      const tag = `${l.id}/${mid}`;
      const model = pool.models.getModel(l.id, mid);
      if (!model) {
        failures.push(`${tag}: not-registered`);
        continue;
      }
      const context: Context = { messages, tools: [] };
      try {
        const res = await withTimeout(
          pool.models.completeSimple(model, context, {
            transformHeaders: async (h) => {
              // Keyed on the ENDPOINT, not the leg id. It used to read
              // `l.id === "go" || l.id === "zenfree"`, so adding a leg called `go-fast`
              // against the same opencode.ai host silently sent NO session header and NO
              // User-Agent -- which the Go docs require, and without which the edge 403s
              // and the gateway 400s. It failed over to a 36s free model and looked like
              // a quota problem. Any opencode.ai leg needs the contract; the id is a name.
              if (isOpenCodeHost(l))
                return { ...h, "x-opencode-session": l.session, "User-Agent": "fam-gods/1.0" };
              if (l.id === "kilo-anon")
                // pi-ai's openai-completions impl throws "No API key" for keyless
                // clients unless an authorization/cf-aig-authorization header is
                // present; the OpenAI SDK lets explicit null strip its injected
                // Bearer, so the wire request stays truly anonymous (:free docs).
                return { ...h, "cf-aig-authorization": "anonymous", Authorization: null as unknown as string };
              return h;
            },
          }),
          ATTEMPT_TIMEOUT_MS,
        );
        if (res.stopReason === "error" || res.stopReason === "aborted") {
          throw new Error(`stopReason=${res.stopReason}`);
        }
        const text = res.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        const cost = res.usage?.cost?.total ?? 0;
        // Log what was SKIPPED to get here, not just the winner. A silent fall-through is
        // how a misconfigured primary hides: the header bug above sent every request to a
        // 36s free model and telemetry recorded only a cheerful success on that model.
        tele({ leg: l.id, model: mid, ok: true, cost, tried, skipped: failures });
        breaker.set(l.id, 0);
        return { leg: l.id, model: mid, text, cost };
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
        failures.push(`${tag}: ${msg}`);
        breaker.set(l.id, (breaker.get(l.id) ?? 0) + 1);
      }
    }
  }
  tele({ ok: false, failures, tried });
  throw new Error(`all legs failed: ${failures.join(" | ")}`);
}
