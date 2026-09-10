// fam-gods cli-legs — gods as CLI subprocesses (Cline + Kilo free models).
// Both CLIs are documented-automation-friendly (headless JSON / --auto runs)
// using THEIR account auth + free quotas. No keys exfiltrated, no ToS gray:
// we drive their CLIs the way their manuals bless. Drilled live 2026-09-09:
//   cline --json -> model cline-free/muse-spark-1.3-contributor, exact reply
//   kilo run --auto -> model deepseek/deepseek-v4-flash-free, exact reply
// Guarding happens downstream (Python Simurg verdict on returned text);
// this layer returns raw text + receipts + telemetry.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// npm shims are .cmd files; execFile cannot run bare names reliably on
// Windows, so resolve explicitly (no shell => no injection surface).
function bin(name: string): string {
  const cands = [
    join(process.env.APPDATA ?? "", "npm", `${name}.cmd`),
    `${name}.cmd`,
    name,
  ];
  for (const c of cands) {
    try {
      if (c.includes("\\") || c.includes("/")) {
        if (existsSync(c)) return c;
      } else {
        return c;
      }
    } catch {
      /* next */
    }
  }
  return name;
}

export interface CliResult {
  leg: string;
  model: string;
  text: string;
  wallMs: number;
}

function tele(record: object): void {
  const dir = join(homedir(), ".commandcode", "fam-gods");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "cli-legs.jsonl"), JSON.stringify({ ts: Date.now(), ...record }) + "\n");
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ out: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    // .cmd shims need shell:true on Node 24. stdin MUST be ignored: cline/kilo
    // treat an open stdin pipe as piped context and wait forever (execFile
    // cannot set stdio per node#60077 — hence spawn). Args array = no quoting
    // games; shell handles the .cmd lookup.
    // DEP0190: shell:true concatenates args unescaped — quote cmd.exe-style
    // here (inner quotes doubled). Tasks stay byte-identical otherwise.
    // Operator-originated tasks only; model-originated prompts pass through
    // the guard + an approval gate before reaching here.
    const q = (a: string) => (/[\s&|<>()%^!"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const child = spawn(q(cmd), args.map(q), {
      timeout: timeoutMs,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let errText = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 4 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (d) => {
      errText += d;
    });
    child.on("error", (e) => reject(new Error(`${cmd}: ${e.message.slice(0, 160)}`)));
    child.on("close", (code) => {
      const ms = Date.now() - t0;
      if (code !== 0 && !out) {
        return reject(new Error(`${cmd}: exit=${code} ${errText.slice(0, 160)}`));
      }
      resolve({ out, ms });
    });
  });
}

const strip = (s: string) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !l.startsWith(">") && !l.startsWith("node.exe"));

export async function clineLeg(task: string, model?: string): Promise<CliResult> {
  const args = ["--json", "--timeout", "300", ...(model ? ["-m", model] : []), task];
  const { out, ms } = await run(bin("cline"), args, 320000);
  let text = "";
  for (const line of out.split("\n")) {
    try {
      const m = JSON.parse(line);
      if (m && m.type === "run_result" && typeof m.text === "string") text = m.text;
    } catch {
      /* partial/stream lines */
    }
  }
  if (!text) throw new Error("cline: no run_result text");
  tele({ leg: "cline", ok: true, wallMs: ms, chars: text.length });
  return { leg: "cline", model: model ?? "cline-free/muse-spark-1.3-contributor", text, wallMs: ms };
}

/** DEPRECATED 2026-09-09: kilo-anon direct HTTPS leg (legs.ts) supersedes this
 *  subprocess path — same free models, none of the process fragility. Kept for
 *  fallback; prefer the pool. */
export async function kiloLeg(task: string): Promise<CliResult> {
  const { out, ms } = await run(bin("kilo"), ["run", "--auto", task], 200000);
  const lines = strip(out);
  const text = lines.length ? lines[lines.length - 1] : "";
  if (!text) throw new Error("kilo: empty reply");
  tele({ leg: "kilo", ok: true, wallMs: ms, chars: text.length });
  return { leg: "kilo", model: "deepseek/deepseek-v4-flash-free", text, wallMs: ms };
}
