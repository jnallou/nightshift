import { run } from "./util.mjs";

const SECRETISH = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|^ASC_|^SENTRY_|^GH_|^GITHUB_|^ACTIONS_|^NIGHTSHIFT_GH/i;

/** The environment handed to anything that runs repo code: no tokens, no keys. */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRETISH.test(k)) out[k] = v;
  return out;
}

/** The agent gets the clean environment plus only what it needs to reach Claude. */
export function agentEnv(env = process.env) {
  const out = cleanEnv(env);
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) if (env[k]) out[k] = env[k];
  // Ask Claude Code to keep its own credentials out of the commands it runs.
  out.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  return out;
}

function parseJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  for (const cand of [text, fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!cand) continue;
    try { return JSON.parse(cand); } catch { /* try the next shape */ }
  }
  return null;
}

/**
 * One headless Claude Code call. `tools` is everything the agent can see;
 * `allowed` is what it may use without asking, and with nobody awake to ask,
 * anything else is refused.
 */
export function askClaude({ cwd, prompt, schema, tools, allowed, cfg, env = process.env }) {
  const bin = env.NIGHTSHIFT_CLAUDE_BIN || "claude";
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--tools", tools.join(","), "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--strict-mcp-config", "--no-session-persistence",
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.budgetUsdPerCall) args.push("--max-budget-usd", String(cfg.budgetUsdPerCall));
  args.push("--allowedTools", ...allowed);
  const r = run(bin, args, { cwd, input: prompt, env: agentEnv(env), timeout: 30 * 60_000 });
  let out;
  try { out = JSON.parse(r.stdout); } catch {
    return { ok: false, error: `Claude did not return JSON (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
  }
  if (Array.isArray(out)) out = out.find((m) => m.type === "result") || {};
  const meta = { cost: out.total_cost_usd || 0, denials: (out.permission_denials || []).length };
  if (out.is_error) return { ok: false, error: String(out.result || out.subtype || "Claude reported an error").slice(0, 400), ...meta };
  const data = out.structured_output ?? parseJson(out.result);
  if (!data || typeof data !== "object") return { ok: false, error: "Claude finished without the structured answer.", ...meta };
  return { ok: true, data, ...meta };
}
