#!/usr/bin/env node
import assert from "node:assert/strict";
import { WebxFacadeClient } from "../packages/sdk/src/facade.js";

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

async function search(query, expectedDomain, requiredPattern, output = "links") {
  const result = await client.request("web.search", { query, ...(output === "extracts" ? { output } : {}), domains: [expectedDomain] }, options());
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
  await search("San Francisco weather forecast", "weather.gov", /san francisco|forecast/iu);
  await search("ECB interest rates 2026", "ecb.europa.eu", /(?:interest|rate).*(?:2026)|(?:2026).*(?:interest|rate)/iu);
  await search("Fedora Linux 44 desktop changes", "fedoraproject.org", /fedora.*44|desktop/iu, "extracts");
  await search("Python 3.14 release support status", "python.org", /python.*3\.14|support/iu, "extracts");

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

  const extracts = await client.request("web.search", {
    query: "latest stable releases Node.js Rust Python Go programming language",
    output: "extracts",
  }, options());
  assert(extracts.data.metadata.searches >= 1 && extracts.data.metadata.searches <= 2);
  assert(extracts.data.metadata.pagesRead > 0);
  assert(extracts.data.hits.length > 0 && extracts.data.hits.length <= 4);

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

  const visual = await client.request("browser.observe", {
    browserSessionId: browserSession.sessionId,
    view: "visual",
    maxChars: 2_000,
  }, options());
  assert(visual.data.screenshot?.payloadBase64.length > 1_000, "browser returned no visual frame");

  await client.request("browser.act", {
    browserSessionId: browserSession.sessionId,
    action: { kind: "wait", milliseconds: 2_000 },
  }, options());
  await client.request("browser.act", {
    browserSessionId: browserSession.sessionId,
    action: { kind: "click", selector: "#issues-tab" },
  }, options());
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const clicked = await client.request("browser.observe", {
    browserSessionId: browserSession.sessionId,
    view: "main",
    maxChars: 3_000,
  }, options());
  assert(clicked.data.url.includes("/issues"), "browser click did not navigate to issues");

  await assert.rejects(
    client.request("browser.open", {
      pathId: "agent-browser/chrome",
      url: "http://127.0.0.1:8787/health",
      visible: false,
    }, options()),
    /loopback|blocked|denied/iu,
  );

  console.log(JSON.stringify({ ok: true, scenarios: 10 }));
} finally {
  if (browserSession?.sessionId) {
    await client.request("browser.tabs", {
      action: "close-session",
      browserSessionId: browserSession.sessionId,
    }, options()).catch(() => undefined);
  }
  await client.stop({ ownerId }).catch(() => undefined);
}
