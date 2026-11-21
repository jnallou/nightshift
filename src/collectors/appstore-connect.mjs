import { createSign } from "node:crypto";
import { signal } from "../signals.mjs";
import { clip, daysAgo } from "../util.mjs";

const API = "https://api.appstoreconnect.apple.com";
const b64 = (x) => Buffer.from(x).toString("base64url");

/** App Store Connect wants a short lived ES256 token signed with your .p8 key. */
export function makeToken({ keyId, issuerId, privateKey }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: issuerId, iat, exp: iat + 15 * 60, aud: "appstoreconnect-v1" }));
  const sig = createSign("SHA256").update(`${head}.${body}`).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64(sig)}`;
}

/** Flatten Apple's call stack tree into readable lines, blamed frames first in line. */
export function frames(node, depth = 0, out = []) {
  for (const f of node || []) {
    if (out.length >= 25) break;
    const where = f.fileName ? ` (${f.fileName}${f.lineNumber ? ":" + f.lineNumber : ""})` : "";
    out.push(`${"  ".repeat(Math.min(depth, 8))}${f.isBlameFrame ? "> " : ""}${f.binaryName || "?"} ${f.symbolName || f.rawFrame || f.address || ""}${where}`);
    frames(f.subFrames, depth + 1, out);
  }
  return out;
}

export async function collect(cfg, ctx) {
  const keyId = ctx.env.ASC_KEY_ID, issuerId = ctx.env.ASC_ISSUER_ID, privateKey = ctx.env.ASC_PRIVATE_KEY;
  const appId = cfg.app.appStoreId;
  if (!keyId || !issuerId || !privateKey || !appId) {
    ctx.warn("App Store Connect is on but ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY or app.appStoreId is missing.");
    return [];
  }
  const token = makeToken({ keyId, issuerId, privateKey: privateKey.replace(/\\n/g, "\n") });
  const since = daysAgo(cfg.sources.appStoreConnect.lookbackDays);
  const get = async (path, accept = "application/json") => {
    const res = await ctx.fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: accept } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  };
  const out = [];
  const part = async (name, fn) => { try { await fn(); } catch (e) { ctx.warn(`App Store Connect ${name}: ${e.message}`); } };
  const fresh = (d) => !d || new Date(d) >= since;

  await part("reviews", async () => {
    const r = await get(`/v1/apps/${appId}/customerReviews?sort=-createdDate&limit=100`);
    for (const { id, attributes: a } of r.data || []) {
      if (a.rating > cfg.sources.appStoreReviews.maxRating || !fresh(a.createdDate)) continue;
      out.push(signal({ source: "appstore", kind: "review", key: id, title: a.title, body: a.body, rating: a.rating, date: a.createdDate, country: a.territory }));
    }
  });

  const device = (a) => [a.deviceModel, a.osVersion && `iOS ${a.osVersion}`].filter(Boolean).join(", ");

  await part("TestFlight screenshot feedback", async () => {
    const r = await get(`/v1/apps/${appId}/betaFeedbackScreenshotSubmissions?sort=-createdDate&limit=50`);
    for (const { id, attributes: a } of r.data || []) {
      if (!fresh(a.createdDate) || !a.comment) continue;
      out.push(signal({ source: "testflight", kind: "feedback", key: id, title: a.comment.split("\n")[0], body: a.comment, device: device(a), date: a.createdDate }));
    }
  });

  await part("TestFlight crash feedback", async () => {
    const r = await get(`/v1/apps/${appId}/betaFeedbackCrashSubmissions?sort=-createdDate&limit=50`);
    let logs = 0;
    for (const { id, attributes: a } of r.data || []) {
      if (!fresh(a.createdDate)) continue;
      let stack;
      if (logs++ < 8) {
        try { stack = clip((await get(`/v1/betaFeedbackCrashSubmissions/${id}/crashLog`)).data?.attributes?.logText || "", 6000); } catch { /* log is optional */ }
      }
      out.push(signal({ source: "testflight", kind: "crash", key: id, title: a.comment?.split("\n")[0] || `TestFlight crash on ${device(a) || "a tester's device"}`, body: a.comment || "", device: device(a), date: a.createdDate, stack }));
    }
  });

  await part("diagnostics", async () => {
    const builds = await get(`/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=2`);
    for (const b of builds.data || []) {
      const sigs = (await get(`/v1/builds/${b.id}/diagnosticSignatures?limit=50`)).data || [];
      sigs.sort((x, y) => (y.attributes.weight || 0) - (x.attributes.weight || 0));
      for (const { id, attributes: a } of sigs.slice(0, 6)) {
        let stack, detail = "";
        try {
          const l = await get(`/v1/diagnosticSignatures/${id}/logs?limit=1`, "application/vnd.apple.diagnostic-logs+json");
          const p = l.productData?.[0];
          detail = (p?.diagnosticInsights || []).map((i) => i.insightsString).filter(Boolean).join(" ");
          const d = p?.diagnosticLogs?.[0];
          stack = frames(d?.callStackTree?.[0]?.callStacks?.[0]?.callStackRootFrames).join("\n");
          if (d?.diagnosticMetaData) detail += ` ${d.diagnosticMetaData.event || ""} ${d.diagnosticMetaData.eventDetail || ""} on ${d.diagnosticMetaData.deviceType || ""}`;
        } catch { /* logs are optional */ }
        const kind = { HANGS: "hang", LAUNCHES: "slow-launch", DISK_WRITES: "disk-writes" }[a.diagnosticType] || "diagnostic";
        out.push(signal({
          source: "xcode-diagnostics", kind, key: `${a.diagnosticType}:${a.signature}`, title: a.signature,
          body: `${a.diagnosticType}. Share of all ${kind} reports in this build: ${Math.round((a.weight || 0) * 100)}%. Trend: ${a.insight?.direction || "unknown"}. ${detail}`.trim(),
          appVersion: b.attributes?.version, stack,
        }));
      }
    }
  });

  await part("performance metrics", async () => {
    const m = await get(`/v1/apps/${appId}/perfPowerMetrics?filter[platform]=IOS`, "application/vnd.apple.xcode-metrics+json");
    for (const r of m.insights?.regressions || []) {
      out.push(signal({
        source: "xcode-metrics", kind: "metric", key: `${r.metricCategory}:${r.metric}:${r.latestVersion}`,
        title: `${r.metric} got worse in ${r.latestVersion}`,
        body: [r.summaryString, ...(r.populations || []).map((p) => p.summaryString)].filter(Boolean).join("\n"),
        appVersion: r.latestVersion, highImpact: r.highImpact || undefined,
      }));
    }
  });

  return out;
}
