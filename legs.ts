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

const GO_BASE = "https://opencode.ai/zen/go/v1"; // impl appends /chat/completions

function fileKeyEnv(varName: string, filePath: string): void {
  if (!process.env[varName]) {
    try {
      process.env[varName] = readFileSync(filePath, "utf-8").trim();
    } catch {
      /* leg stays unconfigured; rotation skips it */
    }
  }
}

function leg(
  id: string,
  name: string,
  baseUrl: string,
  keyEnv: string | null,
  modelIds: string[],
  maxTokens = 4096, // free tiers cap output/min — groq on_demand allows 1000 OTPM
): { id: string; provider: ReturnType<typeof createProvider>; models: string[] } {
  const provider = createProvider({
    id,
    name,
    baseUrl,
    auth: keyEnv
      ? { apiKey: envApiKeyAuth(`${name} key`, [keyEnv]) }
      : { apiKey: { name, resolve: async () => ({ auth: {} }) } },
    models: modelIds.map(
      (mid): Model<"openai-completions"> => ({
        id: mid,
        name: `${name} ${mid}`,
        api: "openai-completions",
        provider: id,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens,
      }),
    ),
    api: openAICompletionsApi(),
  });
  return { id, provider, models: modelIds };
}

export interface PoolLeg extends ReturnType<typeof leg> {
  session: string;
}

export function buildPool(sessionId: string) {
  const kf = (name: string) =>
    process.env[name.toUpperCase()] ??
    join(homedir(), ".config", "opencode", `.${name}-key`);
  fileKeyEnv("OPENCODE_GO_KEY", process.env.FAM_GO_KEY_FILE ?? kf("go"));
  for (const k of ["GROQ_API_KEY", "CEREBRAS_API_KEY", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY"]) {
    fileKeyEnv(k, process.env[`FAM_${k.replace("_API_KEY", "")}_KEY_FILE`] ?? kf(k.toLowerCase().replace("_api_key", "")));
  }
  const models = createModels();
  const legs: PoolLeg[] = [];
  const add = (l: ReturnType<typeof leg>) => {
    models.setProvider(l.provider);
    legs.push({ ...l, session: sessionId });
  };
  // Order = cheap-first. Failures fall through with receipts (rotation below).
  // Kilo anonymous: unauthenticated :free only, 200 req/hr/IP. Base WITHOUT
  // /chat/completions (impl appends it). Keyless => keyEnv null.
  add(leg("kilo-anon", "KiloAnon", "https://api.kilo.ai/api/gateway", null, [
    "nvidia/nemotron-3.5-lightning:free",
  ]));
  add(leg("openrouter-free", "OpenRouterFree", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", [
    "nvidia/nemotron-3.5-lightning:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ]));
  // Pollinations now requires a (free) key: https://enter.pollinations.ai/keys
  add(leg("pollinations", "Pollinations", "https://gen.pollinations.ai/v1", "POLLINATIONS_API_KEY", ["openai/gpt-5.4-nano"]));
  // OVH anonymous trickle (2 RPM/IP, EU). Chat 429'd on first contact 2026-09-09;
  // rotation absorbs it until quota returns. Output capped per anon limits.
  add(leg("ovh", "OVHAnon", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", null, ["gpt-oss-120b"], 1024));
  add(leg("groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", ["qwen/qwen3.8-27b"], 800));
  add(leg("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY", ["qwen-3.8-27b"], 800));
  add(leg("go", "GoFallback", GO_BASE, "OPENCODE_GO_KEY", ["deepseek-v4-flash", "glm-5.3-flash"]));
  // Zen free lane rides the SAME Go key (verified: 7 free variants live here).
  add(leg("zenfree", "ZenFree", "https://opencode.ai/zen/v1", "OPENCODE_GO_KEY", [
    "nemotron-3.5-lightning-free",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "nemotron-3-ultra-free",
  ]));
  return { models, legs };
}

export interface LegResult {
  leg: string;
  model: string;
  text: string;
  cost: number;
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
              if (l.id === "go" || l.id === "zenfree")
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
        tele({ leg: l.id, model: mid, ok: true, cost, tried });
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
