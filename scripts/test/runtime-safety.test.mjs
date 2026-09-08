import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { build } from "esbuild";
import { root } from "./dist-fixture.mjs";

function isolated(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-runtime-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home,"config"), XDG_DATA_HOME: path.join(home,"data"), XDG_STATE_HOME: path.join(home,"state"), XDG_CACHE_HOME: path.join(home,"cache"), XDG_RUNTIME_DIR: path.join(home,"runtime"), TERMINAL_BROWSER_APPDATA: path.join(home,"appdata"), TERMINAL_BROWSER_INTEROP_DIR: path.join(home,"interop"), PI_CODING_AGENT_DIR: path.join(home,"pi"), PI_OFFLINE: "1" };
  for (const directory of Object.values(env).filter((value) => value.startsWith(home))) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { home, env };
}
function tree(directory) {
  const result = [];
  function walk(file) {
    const stat = fs.lstatSync(file);
    result.push([path.relative(directory,file),stat.mode,stat.size,stat.mtimeMs,stat.isFile()?fs.readFileSync(file).toString('base64'):null]);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file,name));
  }
  walk(directory); return result;
}
const aliases = { "pixel-store": path.join(root,"store/src/index.ts"), "pixel-terminals": path.join(root,"terminals/src/index.ts"), "pixel-react": path.join(root,"engine/packages/pixel-react/src/index.ts") };

test("doctor is nonmutating, bounded, redacted and graphics remains unknown without a TTY", async (t) => {
  const box = isolated(t);
  const output = path.join(box.home,"main.cjs");
  await build({ entryPoints:[path.join(root,"cli/src/main.ts")], outfile:output, bundle:true, platform:"node", format:"cjs", alias:aliases, external:["electron","*.node"], logLevel:"silent" });
  fs.writeFileSync(path.join(box.env.XDG_DATA_HOME,"terminal-browser.db"), "PRIVATE_DB_CANARY");
  fs.writeFileSync(path.join(box.env.XDG_CONFIG_HOME,"kitty.conf"), "PRIVATE_GRAPHICS_CONFIG_CANARY");
  fs.writeFileSync(path.join(box.env.PI_CODING_AGENT_DIR,"settings.json"), JSON.stringify({secret:"PRIVATE_SETTINGS_CANARY",packages:[]}));
  const before=tree(box.home);
  const result=execFileSync(process.execPath,[output,"doctor","--json"],{env:box.env,encoding:"utf8"});
  const value=JSON.parse(result);
  assert.equal(value.graphics.state,"unknown");
  assert.equal(value.automaticRepair,false);
  assert(!result.includes("CANARY"));
  assert.deepEqual(tree(box.home),before);
  const invalid=path.join(box.home,'invalid-receipt.json');fs.writeFileSync(invalid,'{"secret":"INVALID_CONFIG_CANARY"}',{mode:0o600});
  const invalidBefore=tree(box.home);const unknown=execFileSync(process.execPath,[output,"doctor","--json"],{env:{...box.env,TERMINAL_BROWSER_INSTALLATION:invalid},encoding:"utf8"});assert.equal(JSON.parse(unknown).automaticRepair,false);assert(!unknown.includes('CANARY'));assert.deepEqual(tree(box.home),invalidBefore);fs.unlinkSync(invalid);
  const afterInvalid=tree(box.home);
  assert.throws(()=>execFileSync(process.execPath,[output,"upgrade"],{env:box.env,stdio:"pipe"}));
  assert.deepEqual(tree(box.home),afterInvalid);
});

test("daemon captures identity, inventories ordinary and companion sessions, rejects stale clients and replacement races", async (t) => {
  const box=isolated(t);
  const artifact=path.join(box.home,"artifact");
  fs.mkdirSync(path.join(artifact,"browser/dist"),{recursive:true});
  fs.writeFileSync(path.join(artifact,"browser/dist/main.js"),"captured build A");
  const {createHash}=await import('node:crypto');fs.writeFileSync(path.join(artifact,'build-manifest.json'),JSON.stringify({artifactId:'a'.repeat(64),identity:{source:{commit:'a'.repeat(40)}},files:[{path:'browser/dist/main.js',sha256:createHash('sha256').update('captured build A').digest('hex')}]}));
  const electron=path.join(box.home,"electron.ts");
  fs.writeFileSync(electron,`import {EventEmitter} from 'node:events'; export const app = Object.assign(new EventEmitter(), {exit(code:number){ globalThis.exits.push(code); this.emit('will-quit'); },quit(){globalThis.exits.push(0);this.emit('will-quit');}});`);
  const sessions=path.join(box.home,"session.ts");
  fs.writeFileSync(sessions,`export function createSession(ctx:any) { const metadata={key:ctx.key,owner:ctx.env.owner??null,terminal:'herdr',tab:'actual-tab',pane:ctx.env.pane??'ordinary-pane'};globalThis.created.push(metadata); return { metadata:()=>metadata,ready:Promise.resolve(),nudgeResize(){},close(){ctx.onClose(0);} }; }`);
  const daemon=path.join(box.home,"daemon.cjs");
  await build({entryPoints:[path.join(root,"browser/src/daemon.ts")],outfile:daemon,bundle:true,platform:"node",format:"cjs",alias:aliases,plugins:[{name:"owned-test-seams",setup(b){b.onResolve({filter:/^electron$/},()=>({path:electron}));b.onResolve({filter:/^\.\/session\/session$/},()=>({path:sessions}));}}],logLevel:"silent"});
  const runner=path.join(box.home,"run.cjs");
  fs.writeFileSync(runner,`const assert=require('node:assert/strict'),net=require('node:net'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');global.exits=[];global.created=[];
const socket=path.join(process.env.XDG_RUNTIME_DIR,'terminal-browser-'+crypto.createHash('sha256').update(process.env.TERMINAL_BROWSER_DIST_ROOT).digest('hex').slice(0,8),'daemon.sock');
const peers=[];function request(message,keep=false){if(message.cmd==='open')message.expectedInstance=message.identity?.instanceId;return new Promise((resolve,reject)=>{const c=net.connect(socket);peers.push(c);let b='';c.on('error',reject);c.on('data',chunk=>{b+=chunk;const n=b.indexOf('\\n');if(n>=0){const value=JSON.parse(b.slice(0,n));if(!keep)c.destroy();resolve(value);}});c.on('connect',()=>c.write(JSON.stringify(message)+'\\n'));});}
(async()=>{await require(${JSON.stringify(daemon)}).runDaemon(null);await new Promise(r=>setTimeout(r,30));
const first=await request({cmd:'status'});assert.equal(first.complete,true);assert.deepEqual(first.sessions,[]);const identity=first.identity;
const stale=await request({cmd:'open',identity:{...identity,build:'0'.repeat(64)},tty:'/dev/test'});assert.equal(stale.ok,false);assert.equal(global.created.length,0);assert.deepEqual(global.exits,[]);
await request({cmd:'open',identity,tty:'/dev/test',env:{}},true);
const owner={workspaceId:'workspace-1',tabId:'owner-tab',paneId:'owner-pane'};
await request({cmd:'open',identity,tty:'/dev/test',env:{owner,pane:'actual-companion'}},true);
const occupied=await request({cmd:'status'});assert.equal(occupied.sessions.length,2);assert.equal(occupied.sessions[0].owner,null);assert.deepEqual(occupied.sessions[1].owner,owner);assert.equal(occupied.sessions[1].pane,'actual-companion');
assert.equal((await request({cmd:'open',identity:{...identity,build:'0'.repeat(64)},tty:'/dev/test'})).ok,false);assert.deepEqual(global.exits,[]);
fs.writeFileSync(path.join(process.env.TERMINAL_BROWSER_DIST_ROOT,'browser/dist/main.js'),'changed build B');assert.deepEqual((await request({cmd:'status'})).identity,identity);
await request({cmd:'open',identity,tty:'/dev/test',env:{}},true);
const expected={identity:occupied.identity,sessions:occupied.sessions,complete:true};assert.equal((await request({cmd:'shutdown',expected})).ok,false);assert.deepEqual(global.exits,[]);
const fresh=await request({cmd:'status'});assert.equal(fresh.sessions.length,3);assert.equal((await request({cmd:'shutdown',expected:{identity:fresh.identity,sessions:fresh.sessions,complete:true}})).ok,true);await new Promise(r=>setTimeout(r,80));assert.equal(global.exits.length,1);assert(!fs.existsSync(socket));for(const peer of peers)peer.destroy();console.log('passed');process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});`);
  assert.equal(execFileSync(process.execPath,[runner],{env:{...box.env,TERMINAL_BROWSER_DIST_ROOT:artifact},encoding:"utf8",timeout:10000}).trim(),"passed");
});

test("versioned releases share pinned state in place; occupied profiles never switch and owner equality ignores cwd/session", async(t)=>{
  const box=isolated(t), receipt=path.join(box.home,'installation.json');
  const paths={dataHome:box.env.XDG_DATA_HOME,stateHome:box.env.XDG_STATE_HOME,cacheHome:box.env.XDG_CACHE_HOME,runtimeHome:box.env.XDG_RUNTIME_DIR,appData:box.env.TERMINAL_BROWSER_APPDATA,interopState:box.env.TERMINAL_BROWSER_INTEROP_DIR,interopShare:box.env.TERMINAL_BROWSER_INTEROP_DIR};
  fs.writeFileSync(receipt,JSON.stringify({schemaVersion:1,namespace:'terminal-browser-dev-61753e09',paths}),{mode:0o600});
  const entry=path.join(box.home,'paths.ts');
  fs.writeFileSync(entry,`import {APP_DIR_NAME,DATA_DIR,DB_FILE,DAEMON_SOCKET,INSTANCES_DIR,AGENT_SOCKETS_DIR} from ${JSON.stringify(path.join(root,'store/src/paths.ts'))};import {sameBrowserOwner} from ${JSON.stringify(path.join(root,'store/src/owner.ts'))};const a={workspaceId:'w',tabId:'t',paneId:'p',sessionId:'a',projectDir:'/a'};if(!sameBrowserOwner(a,{...a,sessionId:'b',projectDir:'/b'}))throw Error('owner changed');console.log(JSON.stringify({APP_DIR_NAME,DATA_DIR,DB_FILE,DAEMON_SOCKET,INSTANCES_DIR,AGENT_SOCKETS_DIR}));`);
  const compiled=path.join(box.home,'paths.cjs');await build({entryPoints:[entry],outfile:compiled,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const execute=dist=>execFileSync(process.execPath,[compiled],{env:{...box.env,TERMINAL_BROWSER_DIST_ROOT:dist,TERMINAL_BROWSER_INSTALLATION:receipt},encoding:'utf8'});
  assert.equal(execute(path.join(box.home,'A')),execute(path.join(box.home,'B')));
  const unrelated=path.join(paths.appData,'terminal-browser-dev-baadb0eb');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'retained'),'unrelated');
  const occupied=path.join(paths.appData,'terminal-browser-dev-61753e09');fs.mkdirSync(occupied);fs.writeFileSync(path.join(occupied,'terminal-browser.lock'),'uncertain');
  const electron=path.join(box.home,'profile-electron.ts');fs.writeFileSync(electron,`export const app={getPath(){return '/not-used';},setPath(){throw Error('must not switch');},on(){}};`);
  const profile=path.join(box.home,'profile.cjs');await build({entryPoints:[path.join(root,'browser/src/profile.ts')],outfile:profile,bundle:true,platform:'node',format:'cjs',alias:{...aliases,electron},logLevel:'silent'});
  const before=tree(paths.appData);
  assert.throws(()=>execFileSync(process.execPath,['-e',`require(${JSON.stringify(profile)}).claimProfile()`],{env:{...box.env,TERMINAL_BROWSER_INSTALLATION:receipt},stdio:'pipe'}));
  assert.deepEqual(tree(paths.appData),before);
});

test("CLI refuses legacy, idle/occupied mismatches, stale sockets and uncertain profile ownership without spawn or mutation replay",async(t)=>{
 const box=isolated(t), artifact=path.join(box.home,'artifact');fs.mkdirSync(path.join(artifact,'browser/dist'),{recursive:true});fs.mkdirSync(path.join(artifact,'electron'));fs.writeFileSync(path.join(artifact,'browser/dist/main.js'),'build A');
 const marker=path.join(box.home,'spawned');fs.writeFileSync(path.join(artifact,'electron/electron'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
 const output=path.join(box.home,'client.cjs');await build({entryPoints:[path.join(root,'cli/src/main.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',alias:aliases,external:['electron','*.node'],plugins:[{name:'export-client-seam',setup(b){b.onLoad({filter:/cli\/src\/main\.ts$/},()=>{const source=fs.readFileSync(path.join(root,'cli/src/main.ts'),'utf8');return{contents:source.slice(0,source.indexOf('void main()'))+'export {openSession};',loader:'ts'};});}}],logLevel:'silent'});
 const {createHash}=await import('node:crypto');const namespace='terminal-browser-'+createHash('sha256').update(artifact).digest('hex').slice(0,8);const socket=path.join(box.env.XDG_RUNTIME_DIR,namespace,'daemon.sock');fs.mkdirSync(path.dirname(socket),{recursive:true});
 const run=async()=>{const child=spawn(process.execPath,['-e',`require(${JSON.stringify(output)}).openSession(['https://MUTATION_CANARY.invalid'],'/dev/test').then(()=>process.exit(2),()=>process.exit(0))`],{env:{...box.env,TERMINAL_BROWSER_DIST_ROOT:artifact},stdio:'pipe'});const [code]=await once(child,'close');assert.equal(code,0);assert(!fs.existsSync(marker));};
 for(const mode of ['legacy','idle','occupied']){
  const messages=[];const peers=new Set();const server=net.createServer(c=>{peers.add(c);c.on('close',()=>peers.delete(c));c.on('data',chunk=>{const request=JSON.parse(chunk.toString());messages.push(request);if(mode!=='legacy')c.end(JSON.stringify({ok:true,identity:{protocol:2,build:'0'.repeat(64),artifactId:null,instanceId:'mismatch'},sessions:mode==='idle'?[]:[{key:'occupied'}],complete:true})+'\n');});});await new Promise(resolve=>server.listen(socket,resolve));await run();assert(messages.every(message=>message.cmd==='hello'));for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve));
 }
 fs.writeFileSync(socket,'stale socket placeholder');await run();assert.equal(fs.readFileSync(socket,'utf8'),'stale socket placeholder');fs.unlinkSync(socket);
 const profile=path.join(box.env.TERMINAL_BROWSER_APPDATA,namespace);fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'terminal-browser.lock'),'unknown');await run();assert.equal(fs.readFileSync(path.join(profile,'terminal-browser.lock'),'utf8'),'unknown');
});
