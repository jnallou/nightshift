import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Run a program with an argument list. Never goes through a shell. */
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeout || 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  if (r.error) out.stderr += String(r.error.message || r.error);
  if (opts.check && out.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${out.code}): ${out.stderr.trim() || out.stdout.trim()}`);
  }
  return out;
}

/** Run a shell command line (used only for commands the repo owner wrote in config). */
export function shell(line, opts = {}) {
  return run("sh", ["-c", line], opts);
}

export const hash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

export const clip = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "\n[cut]" : s;
};

export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "fix";

/** Tiny glob: ** crosses folders, * stays inside one. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

export const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

export function log(...a) {
  console.log("[nightshift]", ...a);
}
