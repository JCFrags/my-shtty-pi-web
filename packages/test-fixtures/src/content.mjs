import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const FIXTURE_SEED = "webx-fixture-seed-v1";
export const AUTH_CANARY = "WEBX_SYNTHETIC_AUTH_CANARY_6caa12";

const article = (version, text) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WebX Fixture ${version}</title>
<meta name="description" content="Deterministic local fixture"></head>
<body><header>Stable navigation</header><main><article><h1>Fixture article ${version}</h1>
<p>${text}</p><p lang="es">Información técnica estable.</p>
<table><tr><th>key</th><th>value</th></tr><tr><td>seed</td><td>${FIXTURE_SEED}</td></tr></table>
</article></main></body></html>\n`;

export const bodies = Object.freeze({
  static: article("v1", "The first canonical body is stable."),
  changedV1: article("v1", "The watched value is alpha."),
  changedV2: article("v2", "The watched value is beta."),
  spa: "<!doctype html><html><head><title>SPA shell</title><script type=\"module\" src=\"/subresources/app.js\"></script></head><body><main id=\"app\">Loading</main></body></html>\n",
  spaScript: "document.querySelector('#app').innerHTML='<h1>Rendered fixture</h1><p>Stable browser content.</p>';\n",
  style: "body { font-family: sans-serif; }\n",
  malformed: "<!doctype html><html><head><title>Malformed</title><body><main><h1>Open elements<p>Still deterministic\n",
  robots: "User-agent: *\nAllow: /\nDisallow: /crawl/private\n",
  rss: "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>WebX fixture</title><link>http://fixture.invalid/</link><item><guid>item-v1</guid><title>Stable item</title><link>http://fixture.invalid/html/static</link></item></channel></rss>\n",
  atom: "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><id>urn:webx:fixture</id><title>WebX fixture</title><updated>2026-08-09T00:00:00Z</updated><entry><id>urn:webx:item:v1</id><title>Stable item</title><updated>2026-08-09T00:00:00Z</updated></entry></feed>\n",
  api: JSON.stringify({ fixture: "webx", seed: FIXTURE_SEED, items: [{ id: "item-1", value: 7 }] }) + "\n",
  browserSecurity: `<!doctype html><html><head><title>Security subresource candidates</title></head><body>
<iframe src="http://10.0.0.9/private"></iframe>
<img src="http://169.254.169.254/latest/meta-data">
<video src="http://127.0.0.1/protected/resource"></video>
<script type="application/json" id="webx-security-candidates">["fetch","xhr","websocket","service_worker","iframe","media"]</script>
</body></html>\n`,
});

export const largeBody = Buffer.from(`${FIXTURE_SEED}\n`.repeat(65536), "utf8");
export const compressedLargeBody = gzipSync(largeBody, { level: 9, mtime: 0 });

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const routeDefinitions = [
  ["health", "GET", "/health", "application/json", "generated"],
  ["manifest", "GET", "/manifest.json", "application/json", "generated"],
  ["html-static", "GET", "/html/static", "text/html", "CC0-1.0 generated"],
  ["html-changed-v1", "GET", "/html/changed/v1", "text/html", "CC0-1.0 generated"],
  ["html-changed-v2", "GET", "/html/changed/v2", "text/html", "CC0-1.0 generated"],
  ["spa-shell", "GET", "/spa", "text/html", "CC0-1.0 generated"],
  ["redirect", "GET", "/redirect/static", "text/plain", "generated"],
  ["malformed", "GET", "/html/malformed", "text/html", "CC0-1.0 generated"],
  ["large", "GET", "/bounds/large", "application/octet-stream", "generated"],
  ["compressed", "GET", "/bounds/compressed", "application/octet-stream", "generated"],
  ["robots", "GET", "/robots.txt", "text/plain", "CC0-1.0 generated"],
  ["auth", "GET", "/auth/basic", "application/json", "generated synthetic canary"],
  ["subresource-js", "GET", "/subresources/app.js", "text/javascript", "CC0-1.0 generated"],
  ["subresource-css", "GET", "/subresources/style.css", "text/css", "CC0-1.0 generated"],
  ["crawl-root", "GET", "/crawl/", "text/html", "CC0-1.0 generated"],
  ["crawl-a", "GET", "/crawl/a", "text/html", "CC0-1.0 generated"],
  ["crawl-b", "GET", "/crawl/b", "text/html", "CC0-1.0 generated"],
  ["crawl-private", "GET", "/crawl/private", "text/html", "CC0-1.0 generated"],
  ["rss", "GET", "/feeds/rss.xml", "application/rss+xml", "CC0-1.0 generated"],
  ["atom", "GET", "/feeds/atom.xml", "application/atom+xml", "CC0-1.0 generated"],
  ["api", "GET", "/api/items", "application/json", "CC0-1.0 generated"],
  ["security-manifest", "GET", "/security/manifest.json", "application/json", "generated"],
  ["security-browser-subresources", "GET", "/security/browser-subresources", "text/html", "CC0-1.0 generated"],
  ["security-redirect-start", "GET", "/security/redirect/start", "text/plain", "generated"],
  ["security-redirect-private", "GET", "/security/redirect/private", "text/plain", "generated"],
  ["protected-counter", "GET", "/protected/counter", "application/json", "generated"],
  ["protected-reset", "POST", "/protected/reset", "application/json", "generated"],
  ["protected-resource", "GET", "/protected/resource", "application/json", "generated"],
  ["failure-status", "GET", "/failure/status/503", "text/plain", "generated"],
  ["failure-slow", "GET", "/failure/slow", "text/plain", "generated"],
  ["failure-disconnect", "GET", "/failure/disconnect", "none", "generated"],
];

export function createManifest() {
  const contentByPath = {
    "/html/static": bodies.static,
    "/html/changed/v1": bodies.changedV1,
    "/html/changed/v2": bodies.changedV2,
    "/spa": bodies.spa,
    "/html/malformed": bodies.malformed,
    "/bounds/large": largeBody,
    "/bounds/compressed": compressedLargeBody,
    "/robots.txt": bodies.robots,
    "/subresources/app.js": bodies.spaScript,
    "/subresources/style.css": bodies.style,
    "/feeds/rss.xml": bodies.rss,
    "/feeds/atom.xml": bodies.atom,
    "/api/items": bodies.api,
    "/security/browser-subresources": bodies.browserSecurity,
  };
  const routes = routeDefinitions.map(([id, method, path, contentType, license]) => ({
    id,
    method,
    path,
    contentType,
    license,
    ...(contentByPath[path] === undefined ? {} : { contentSha256: sha256(contentByPath[path]) }),
  }));
  const routeDigest = sha256(JSON.stringify(routes));
  return Object.freeze({
    schemaVersion: "1.0.0",
    fixtureVersion: `1.0.0+sha256.${routeDigest.slice(0, 16)}`,
    seed: FIXTURE_SEED,
    generatedAt: "2026-08-09T00:00:00Z",
    license: "CC0-1.0 for generated fixture content",
    routes,
    routeDigest,
  });
}
