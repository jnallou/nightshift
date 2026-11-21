import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { matchesAny } from "../src/util.mjs";
import { signal } from "../src/signals.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { collect as reviews } from "../src/collectors/appstore-reviews.mjs";
import { collect as asc, makeToken, frames } from "../src/collectors/appstore-connect.mjs";
import { collect as sentry, stackOf } from "../src/collectors/sentry.mjs";
import { filterNew, marker, readMarker, lessons } from "../src/history.mjs";
import { cleanEnv, agentEnv } from "../src/agent.mjs";

const cfg = (over = {}) => ({ ...structuredClone(DEFAULTS), app: { name: "Demo", appStoreId: "42", countries: ["us"] }, ...over });
const ctx = (routes, env = {}) => {
  const warnings = [], calls = [];
  return {
    warnings, calls, env, warn: (m) => warnings.push(m),
    fetch: async (url, init) => {
      calls.push({ url, headers: init?.headers });
      const key = Object.keys(routes).find((k) => url.includes(k));
      return key ? { ok: true, status: 200, json: async () => routes[key] } : { ok: false, status: 404, json: async () => ({}) };
    },
  };
};
const now = new Date().toISOString();

test("protected paths match the files that matter", () => {
  const p = DEFAULTS.protectedPaths;
  for (const f of [".github/workflows/ci.yml", ".nightshift/config.json", ".env", "ios/.env.production", "ios/App/GoogleService-Info.plist", "keys/AuthKey_ABC.p8", "fastlane/Fastfile", "ios/App/App.entitlements"]) assert.ok(matchesAny(f, p), f);
  for (const f of ["src/streak.ts", "ios/App/StreakView.swift", "environment.ts", "docs/github.md"]) assert.ok(!matchesAny(f, p), f);
});

test("a signal keeps the same id across runs and differs across sources", () => {
  const a = signal({ source: "sentry", kind: "crash", key: "99", title: "Boom" });
  const b = signal({ source: "sentry", kind: "crash", key: "99", title: "Boom, reworded" });
  const c = signal({ source: "appstore", kind: "review", key: "99", title: "Boom" });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test("App Store reviews: keeps unhappy and recent ones, handles a single entry and an empty feed", async () => {
  const entry = (id, rating, updated = now) => ({ id: { label: id }, title: { label: `t${id}` }, content: { label: "body" }, "im:rating": { label: String(rating) }, "im:version": { label: "1.1.0" }, updated: { label: updated } });
  const many = ctx({ "id=42": { feed: { entry: [entry("1", 1), entry("2", 5), entry("3", 2, "2020-01-01T00:00:00Z")] } } });
  const got = await reviews(cfg(), many);
  assert.deepEqual(got.map((s) => s.title), ["t1"]);
  assert.equal(got[0].rating, 1);
  assert.equal(got[0].appVersion, "1.1.0");
  assert.equal((await reviews(cfg(), ctx({ "id=42": { feed: { entry: entry("9", 3) } } }))).length, 1);
  assert.equal((await reviews(cfg(), ctx({ "id=42": { feed: {} } }))).length, 0);
});

test("App Store Connect: token is a valid ES256 JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const [h, p, s] = makeToken({ keyId: "KID", issuerId: "ISS", privateKey: pem }).split(".");
  const head = JSON.parse(Buffer.from(h, "base64url")), body = JSON.parse(Buffer.from(p, "base64url"));
  assert.deepEqual(head, { alg: "ES256", kid: "KID", typ: "JWT" });
  assert.equal(body.aud, "appstoreconnect-v1");
  assert.ok(body.exp - body.iat <= 20 * 60);
  assert.ok(createVerify("SHA256").update(`${h}.${p}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
});

test("App Store Connect: reviews, TestFlight feedback, diagnostics and metrics become signals", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const env = { ASC_KEY_ID: "K", ASC_ISSUER_ID: "I", ASC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const c = ctx({
    "/customerReviews": { data: [{ id: "r1", attributes: { rating: 2, title: "Lost my streak", body: "gone", createdDate: now, territory: "USA" } }, { id: "r2", attributes: { rating: 5, title: "Love it", body: "", createdDate: now } }] },
    "/betaFeedbackScreenshotSubmissions": { data: [{ id: "s1", attributes: { comment: "Camera button overlaps the tab bar", createdDate: now, deviceModel: "iPhone15,2", osVersion: "18.1", email: "tester@example.com" } }] },
    "/crashLog": { data: { attributes: { logText: "Thread 0 Crashed:\n0 ClockdIn StreakStore.load()" } } },
    "/betaFeedbackCrashSubmissions": { data: [{ id: "c1", attributes: { comment: "", createdDate: now, deviceModel: "iPhone14,5", osVersion: "17.6" } }] },
    "/logs": { productData: [{ diagnosticInsights: [{ insightsString: "Main thread blocked." }], diagnosticLogs: [{ diagnosticMetaData: { event: "hang", deviceType: "iPhone15,2" }, callStackTree: [{ callStacks: [{ callStackRootFrames: [{ binaryName: "ClockdIn", symbolName: "FeedView.body", fileName: "FeedView.swift", lineNumber: 88, isBlameFrame: true, subFrames: [{ binaryName: "UIKitCore", symbolName: "layout" }] }] }] }] }] }] },
    "/diagnosticSignatures": { data: [{ id: "d1", attributes: { diagnosticType: "HANGS", signature: "FeedView.body", weight: 0.42, insight: { direction: "UP" } } }] },
    "/v1/builds?": { data: [{ id: "b1", attributes: { version: "57" } }] },
    "/perfPowerMetrics": { insights: { regressions: [{ metricCategory: "LAUNCH", metric: "launchTime", latestVersion: "1.1.0", summaryString: "Launch time rose 30%.", populations: [{ summaryString: "iPhone 13: +34%" }] }] } },
  }, env);
  const got = await asc(cfg({ sources: { ...DEFAULTS.sources, appStoreConnect: { enabled: true, lookbackDays: 30 } } }), c);
  assert.deepEqual(c.warnings, []);
  const kinds = got.map((s) => `${s.source}:${s.kind}`);
  assert.deepEqual(kinds, ["appstore:review", "testflight:feedback", "testflight:crash", "xcode-diagnostics:hang", "xcode-metrics:metric"]);
  assert.match(got[2].stack, /StreakStore\.load/);
  assert.match(got[3].stack, /> ClockdIn FeedView\.body \(FeedView\.swift:88\)/);
  assert.match(got[3].body, /42%/);
  assert.ok(!JSON.stringify(got).includes("tester@example.com"), "tester emails must never reach the agent");
  assert.ok(c.calls.every((x) => x.headers.Authorization.startsWith("Bearer ")));
  assert.equal(c.calls.find((x) => x.url.includes("/perfPowerMetrics")).headers.Accept, "application/vnd.apple.xcode-metrics+json");
});

test("App Store Connect: one failing part does not lose the others, and missing keys only warn", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const env = { ASC_KEY_ID: "K", ASC_ISSUER_ID: "I", ASC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const c = ctx({ "/customerReviews": { data: [{ id: "r1", attributes: { rating: 1, title: "Bad", body: "x", createdDate: now } }] } }, env);
  assert.equal((await asc(cfg(), c)).length, 1);
  assert.equal(c.warnings.length, 4);
  const none = ctx({}, {});
  assert.deepEqual(await asc(cfg(), none), []);
  assert.equal(none.warnings.length, 1);
});

test("Sentry: issues become signals with the app's own frames, newest call first", async () => {
  const event = { entries: [{ type: "exception", data: { values: [{ type: "TypeError", value: "undefined is not an object", stacktrace: { frames: [{ function: "run", filename: "node_modules/x.js", lineNo: 1, inApp: false }, { function: "computeStreak", filename: "src/streak.ts", lineNo: 41, inApp: true }, { function: "dayKey", filename: "src/dates.ts", lineNo: 9, inApp: true }] } }] } }] };
  const c = ctx({ "/events/latest/": event, "/issues/?": [{ id: "77", shortId: "APP-1", title: "TypeError: undefined is not an object", culprit: "computeStreak", count: "312", userCount: 48, level: "error", firstSeen: now, lastSeen: now, permalink: "https://sentry.io/i/77" }] }, { SENTRY_AUTH_TOKEN: "t" });
  const got = await sentry(cfg({ sources: { ...DEFAULTS.sources, sentry: { enabled: true, host: "https://sentry.io", org: "o", project: "p" } } }), c);
  assert.equal(got.length, 1);
  assert.equal(got[0].count, 312);
  assert.equal(got[0].users, 48);
  assert.match(got[0].stack, /^TypeError: undefined is not an object\n  at dayKey \(src\/dates\.ts:9\)\n  at computeStreak \(src\/streak\.ts:41\)$/);
  assert.match(c.calls[0].url, /\/api\/0\/organizations\/o\/issues\/\?project=p&query=is%3Aunresolved/);
  const native = { entries: [{ type: "threads", data: { values: [{ crashed: false, stacktrace: { frames: [{ function: "idle" }] } }, { crashed: true, stacktrace: { frames: [{ function: "StreakStore.load", filename: "StreakStore.swift", lineNo: 12, inApp: true }] } }] } }] };
  assert.match(stackOf(native), /StreakStore\.load \(StreakStore\.swift:12\)/);
});

test("Apple call stacks are flattened with the blamed frame marked", () => {
  assert.deepEqual(frames([{ binaryName: "App", symbolName: "a", isBlameFrame: true, subFrames: [{ binaryName: "UIKit", symbolName: "b" }] }]), ["> App a", "  UIKit b"]);
});

test("memory: the marker round trips and each past verdict is respected", () => {
  assert.deepEqual(readMarker(`text\n${marker(["a1", "b2"])}`), ["a1", "b2"]);
  assert.deepEqual(readMarker("no marker"), []);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const items = [
    { type: "pr", number: 1, state: "open", at: now, signalIds: ["open1"], feedback: [], title: "a" },
    { type: "pr", number: 2, state: "declined", at: now, signalIds: ["no1"], feedback: ["Not a bug, this is intended."], title: "b" },
    { type: "pr", number: 3, state: "merged", at: old, signalIds: ["back1", "gone1"], feedback: [], title: "c" },
    { type: "pr", number: 4, state: "merged", at: old, signalIds: ["twice"], feedback: [], title: "d" },
    { type: "pr", number: 5, state: "open", at: now, signalIds: ["twice"], feedback: [], title: "e" },
  ];
  const s = (id, date) => ({ id, title: id, date });
  const { fresh, skipped } = filterNew([s("new1"), s("open1"), s("no1"), s("back1", now), s("gone1", old), s("twice", now)], items, DEFAULTS);
  assert.deepEqual(fresh.map((x) => x.id), ["new1", "back1"]);
  assert.match(fresh[1].seenAgainAfter, /#3/);
  assert.deepEqual(skipped.map((x) => x.why), ["already covered by open #1", "you closed #2 without taking it", "handled in #3", "already covered by open #5"]);
  const l = lessons(items);
  assert.match(l, /#2 CLOSED WITHOUT MERGING: b\n {4}reviewer said: Not a bug, this is intended\./);
  assert.match(l, /#3 MERGED/);
});

test("nothing secret reaches the code the agent runs", () => {
  const env = { PATH: "/bin", HOME: "/h", GH_TOKEN: "x", GITHUB_TOKEN: "x", ASC_PRIVATE_KEY: "x", SENTRY_AUTH_TOKEN: "x", ACTIONS_RUNTIME_TOKEN: "x", ANTHROPIC_API_KEY: "k", NPM_TOKEN: "x", MY_API_KEY: "x", DB_PASSWORD: "x" };
  assert.deepEqual(cleanEnv(env), { PATH: "/bin", HOME: "/h" });
  assert.deepEqual(agentEnv(env), { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" });
});
