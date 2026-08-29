import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { AgentSessionId, Observation, SessionStatus } from "./types.js";

export class SpikeServer {
  private server: Server | null = null;
  private port = 0;
  private readonly sockets = new Set<Socket>();
  private readonly eventClients = new Set<ServerResponse>();
  private statusProvider: () => SessionStatus[] = () => [];
  private frameProvider: (id: string) => Observation | null = () => null;
  frameEventsSent = 0;

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.route(request.url ?? "/", response);
    });
    this.server = server;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address");
    this.port = address.port;
  }

  bind(statusProvider: () => SessionStatus[], frameProvider: (id: string) => Observation | null): void {
    this.statusProvider = statusProvider;
    this.frameProvider = frameProvider;
  }

  get origin(): string {
    if (!this.port) throw new Error("Server is not running");
    return `http://127.0.0.1:${this.port}`;
  }

  fixtureUrl(id: AgentSessionId): string {
    return `${this.origin}/fixture/${encodeURIComponent(id)}`;
  }

  publishFrame(observation: Observation): void {
    const event = JSON.stringify({
      type: "frame",
      agentSessionId: observation.agentSessionId,
      targetId: observation.targetId,
      frameSequence: observation.frameSequence,
      capturedAt: observation.capturedAt,
    });
    for (const client of this.eventClients) {
      client.write(`event: frame\ndata: ${event}\n\n`);
      this.frameEventsSent++;
    }
  }

  async close(): Promise<void> {
    for (const response of this.eventClients) response.end();
    this.eventClients.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    this.port = 0;
  }

  private async route(rawUrl: string, response: ServerResponse): Promise<void> {
    const url = new URL(rawUrl, this.origin);
    if (url.pathname === "/") return this.html(response, VIEWER_HTML);
    if (url.pathname.startsWith("/fixture/")) {
      const id = decodeURIComponent(url.pathname.slice("/fixture/".length));
      return this.html(response, fixtureHtml(id));
    }
    if (url.pathname === "/api/sessions") {
      return this.json(response, this.statusProvider());
    }
    if (url.pathname.startsWith("/api/frame/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/frame/".length));
      const frame = this.frameProvider(id);
      if (!frame) return this.text(response, 404, "No frame");
      response.writeHead(200, {
        "Content-Type": frame.mediaType,
        "Content-Length": String(frame.screenshot.length),
        "Cache-Control": "no-store",
        "X-Frame-Sequence": String(frame.frameSequence),
        "X-Target-Id": frame.targetId,
      });
      response.end(frame.screenshot);
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("event: ready\ndata: {}\n\n");
      this.eventClients.add(response);
      response.once("close", () => this.eventClients.delete(response));
      return;
    }
    return this.text(response, 404, "Not found");
  }

  private html(response: ServerResponse, body: string): void {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(body);
  }

  private json(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "Cache-Control": "no-store" });
    response.end(body);
  }

  private text(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(body);
  }
}

function fixtureHtml(id: string): string {
  const safe = id.replace(/[^a-z0-9_-]/gi, "");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Phase 0 ${safe}</title>
<style>
body{margin:0;font:20px system-ui;background:${safe === "agent-a" ? "#dff4ff" : "#fff0df"};color:#18202a}
main{padding:36px}.identity{font-size:34px;font-weight:700}.controls{display:flex;gap:28px;margin:36px 0}
button,input{font:inherit;padding:16px;border:3px solid #18202a;border-radius:9px;background:white}
button{width:190px}input{display:block;width:500px}.state{margin-top:28px;font-family:monospace}
</style></head><body><main>
<div class="identity" id="identity">${safe}</div>
<div class="controls"><button id="increment-one">Add one</button><button id="increment-ten">Add ten</button></div>
<label for="agent-text">Agent text</label><input id="agent-text" aria-label="Agent text" autocomplete="off">
<div class="state" id="state">count=0; text=</div>
<script>
const model={agent:${JSON.stringify(safe)},count:0,text:""};
const render=()=>{model.text=document.querySelector("#agent-text").value;document.querySelector("#state").textContent='count='+model.count+'; text='+model.text;document.body.dataset.count=String(model.count);document.body.dataset.text=model.text};
document.querySelector("#increment-one").addEventListener("click",()=>{model.count+=1;render()});
document.querySelector("#increment-ten").addEventListener("click",()=>{model.count+=10;render()});
document.querySelector("#agent-text").addEventListener("input",render);render();
globalThis.fixtureState=()=>({...model,text:document.querySelector("#agent-text").value});
</script></main></body></html>`;
}

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Phase 0 multi-agent viewer</title>
<style>body{margin:0;background:#16191f;color:#f2f4f8;font:15px system-ui}header{padding:14px 20px;background:#242936}main{display:grid;grid-template-columns:240px 1fr;min-height:calc(100vh - 54px)}nav{padding:16px;border-right:1px solid #343b49}button{display:block;width:100%;margin:0 0 10px;padding:12px;text-align:left}.panel{padding:18px}img{max-width:100%;border:1px solid #596174;background:white}.status{margin:8px 0 14px;font-family:monospace}</style>
</head><body><header>Screenshot-first browser spike viewer</header><main><nav id="sessions"></nav><section class="panel"><div class="status" id="status">Waiting for frames</div><img id="frame" alt="Selected agent screenshot"></section></main>
<script>
let selected="agent-a", sessions=[];
const refresh=async()=>{sessions=await (await fetch('/api/sessions',{cache:'no-store'})).json();renderNav();renderFrame()};
const renderNav=()=>{const nav=document.querySelector('#sessions');nav.textContent='';for(const s of sessions){const b=document.createElement('button');b.textContent=s.agentSessionId+(s.connected?' • connected':' • offline');b.onclick=()=>{selected=s.agentSessionId;renderNav();renderFrame()};if(s.agentSessionId===selected)b.disabled=true;nav.appendChild(b)}};
const renderFrame=()=>{const s=sessions.find(v=>v.agentSessionId===selected);if(!s)return;const age=s.lastFrameAt?Date.now()-Date.parse(s.lastFrameAt):0;document.querySelector('#status').textContent=s.agentSessionId+' | '+s.url+' | frame '+s.latestFrameSequence+' | age '+age+'ms | cursor '+Math.round(s.cursor.x)+','+Math.round(s.cursor.y);document.querySelector('#frame').src='/api/frame/'+encodeURIComponent(selected)+'?frame='+s.latestFrameSequence};
new EventSource('/events').addEventListener('frame',()=>refresh());setInterval(refresh,1000);refresh();
</script></body></html>`;
