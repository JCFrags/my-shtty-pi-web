#!/usr/bin/env node
import assert from "node:assert/strict";
import { WebxFacadeClient } from "../apps/pi-webx/vendor/sdk/facade-structured-v2.js";

const runtime = process.env.XDG_RUNTIME_DIR;
assert(runtime, "XDG_RUNTIME_DIR is required");
const client = new WebxFacadeClient(process.env.WEBXD_SOCKET ?? `${runtime}/pi-web/webxd.sock`);
const ownerId = `live-acceptance-${process.pid}`;
const signal = AbortSignal.timeout(300_000);
let sequence = 0;
const options = () => ({
  ownerId,
  cwd: process.cwd(),
  signal,
  idempotencyKey: `${ownerId}-${++sequence}`,
});

function hostname(url) {
  return new URL(url).hostname.replace(/^www\./u, "");
}

async function search(query, expectedDomain, requiredPattern) {
  const result = await client.request("web.search", { query, limit: 5 }, options());
  assert(result.data.hits.length > 0, `${query}: no eligible results`);
  for (const hit of result.data.hits) {
    const host = hostname(hit.url);
    assert(host === expectedDomain || host.endsWith(`.${expectedDomain}`), `${query}: wrong domain ${host}`);
  }
  assert(
    result.data.hits.some((hit) => requiredPattern.test(`${hit.title} ${hit.snippet} ${hit.url}`)),
    `${query}: required terms missing`,
  );
}

let browserSession;
try {
  await client.start({ ownerId, cwd: process.cwd(), signal });
  await search("San Francisco weather forecast site:weather.gov", "weather.gov", /san francisco|forecast/iu);
  await search("ECB interest rates 2026 site:ecb.europa.eu", "ecb.europa.eu", /(?:interest|rate).*(?:2026)|(?:2026).*(?:interest|rate)/iu);
  await search('"Fedora Workstation 44" site:fedoramagazine.org', "fedoramagazine.org", /fedora workstation 44/iu);

  const structured = await client.request("web.read", {
    url: "https://api.github.com/repos/nodejs/node/releases",
    fields: ["tag_name", "name"],
    itemOffset: 0,
    itemLimit: 3,
    maxChars: 10_000,
  }, options());
  assert.equal(structured.data.metadata.source, "structured-json");
  assert.equal(structured.data.metadata.substituted, false);
  assert.equal(structured.data.metadata.reader.returnedItems, 3);
  assert(structured.data.metadata.reader.nextItemOffset > 0);

  const research = await client.request("web.research", {
    question: "What are the latest stable releases of Node.js, Rust, Python, and the Go programming language?",
    mode: "research",
    maxQueries: 6,
    maxPages: 8,
    maxBytes: 32_000,
  }, options());
  const researchHosts = new Set(research.data.sources.map((source) => hostname(source.url)));
  for (const domain of ["nodejs.org", "rust-lang.org", "python.org", "go.dev"]) {
    assert([...researchHosts].some((host) => host === domain || host.endsWith(`.${domain}`)), `research omitted ${domain}`);
  }

  const opened = await client.request("browser.open", {
    pathId: "agent-browser/chrome",
    url: "https://github.com/badlogic/pi-mono",
    visible: false,
  }, options());
  browserSession = opened.data;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const observed = await client.request("browser.observe", {
    browserSessionId: browserSession.sessionId,
    view: "main",
    maxChars: 5_000,
  }, options());
  assert(hostname(observed.data.url) === "github.com");
  assert(observed.data.content.length > 500, "browser returned no useful page content");

  await assert.rejects(
    client.request("browser.open", {
      pathId: "agent-browser/chrome",
      url: "http://127.0.0.1:8787/health",
      visible: false,
    }, options()),
    /loopback|blocked|denied/iu,
  );

  console.log(JSON.stringify({ ok: true, scenarios: 7 }));
} finally {
  if (browserSession?.sessionId) {
    await client.request("browser.tabs", {
      action: "close-session",
      browserSessionId: browserSession.sessionId,
    }, options()).catch(() => undefined);
  }
  await client.stop({ ownerId }).catch(() => undefined);
}
