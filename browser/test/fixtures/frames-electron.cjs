const { app, nativeImage } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BrowserController } = require('../../dist/page/controller.js');
const { BrowserAgentRuntime } = require('../../dist/agent/runtime.js');
const { BrowserControl } = require('../../dist/agent/control.js');
const { createSlowNaturalPersona } = require('../../dist/agent/interaction-profile.js');
const directory = mkdtempSync(join(tmpdir(), 'terminal-browser-frames-'));
app.setPath('userData', join(directory, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('site-per-process');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const port = server.address().port;
  const root = `http://127.0.0.1:${port}`;
  const cross = `http://localhost:${port}`;
  const controls = `<button id="save" style="background:rgb(255,0,0);width:120px;height:36px" onclick="counts.save++">Save</button>
<label>Name<input id="name"></label><input id="file" type="file" aria-label="Upload">
<div id="drag" draggable="true">Drag</div><div id="drop" ondragover="event.preventDefault()" ondrop="event.preventDefault();counts.drop++">Drop</div>
<script>window.counts={save:0,drop:0};window.ready=true;</script>`;
  if (req.url === '/root' || req.url === '/popup') {
    res.end(`<!doctype html><style>body{margin:0}iframe{position:absolute;left:100px;top:100px;width:450px;height:350px;border:10px solid blue}#same{left:560px;width:180px}</style>
<button onclick="window.rootCount=(window.rootCount||0)+1">Save</button>
<iframe id="cross" name="cross" src="${cross}/child"></iframe><iframe id="same" name="same" src="${root}/leaf"></iframe>
<button id="open" style="position:absolute;top:480px" onclick="window.open('${root}/popup','frame-popup','width=800,height=600')">Popup</button><script>window.ready=true</script>`);
  } else if(req.url === '/child') {
    res.end(`<!doctype html><style>body{margin:20px}input{width:90px}#drag,#drop{display:inline-block;width:80px;height:30px}#scroll{height:150px;overflow:auto}iframe{margin-top:300px;width:300px;height:180px;border:6px solid green}</style>${controls}<div id="scroll"><iframe id="nested" name="nested" src="${root}/leaf"></iframe><iframe name="same-nested" src="${cross}/leaf"></iframe></div>`);
  } else res.end(`<!doctype html><style>body{margin:12px}input{width:90px}#drag,#drop{display:inline-block;width:80px;height:30px}</style>${controls}`);
});
let controller;
(async () => {
  assert.equal(process.versions.electron, '43.3.0');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const surface = () => ({ clear() {}, close() {}, present(frame) { frame.released?.(); } });
  controller = new BrowserController(surface(), surface(), surface(), { x: 0, y: 0, width: 800, height: 600, scale: 1 }, `http://127.0.0.1:${server.address().port}/root`, {
    cwd: directory, background: '#222222', visible: true, partition: null, tabsAsPopups: false,
    clipboardRead: false, sessionKey: 'frames-fixture', appTabId: null,
  }, () => {});
  let runtime, popupRuntime;
  const rootTargets=[],popupTargets=[];
  const control = new BrowserControl({ onTransition: () => { runtime?.invalidateControl(); popupRuntime?.invalidateControl(); } });
  const persona = createSlowNaturalPersona({ seed: 42 });
  runtime = new BrowserAgentRuntime(controller, { control, personaProvider: () => persona, onActivityChange:activity=>{if(activity?.target)rootTargets.push(activity.target);} });
  controller.dialogs.configure(1,control);
  controller.onMainFrameNavigationStart = () => runtime.invalidateDocument();
  for(let attempt=0; ; attempt++) {
    if(await controller.runJs('window.ready===true').catch(()=>false)) break;
    if(attempt>500) throw new Error('fixture load timed out');
    await wait(10);
  }
  await wait(200);
  const main = await runtime.observe({frame:'main'});
  const cross = main.frames.find(frame=>frame.name==='cross');
  assert(cross, 'cross-origin frame must be listed');
  const child = await runtime.observe({frame:cross.ref});
  assert(controller.frames.selectedFrame().session, 'fixture must cover a real OOPIF session');
  assert(child.snapshot.elements.some(element=>element.name==='Save'));
  assert(child.snapshot.elements.every(element=>!main.snapshot.elements.some(root=>root.ref===element.ref)));
  const js = source => controller.frames.evaluate(source);
  const request = async(extra={}) => {const observation=await runtime.observe();return {observationId:observation.observationId,expectedControlEpoch:control.controlEpoch,...extra};};
  const locator = id => [{kind:'css',value:'#'+id}];
  console.log('STAGE audit-regressions');
  await assert.rejects(runtime.click(await request({locator:[{kind:'css',value:'['}]})), error => {
    assert.match(error.message, /not a valid selector/);
    assert(!error.message.includes('\n'));
    assert(error.message.length < 350);
    return true;
  });
  await js("document.body.insertAdjacentHTML('beforeend','<div id=filtered style=width:80px;height:30px>Filtered content</div>')");
  const filtered = await runtime.observe({filter:locator('filtered')});
  const generic = filtered.snapshot.elements.find(element=>element.name==='Filtered content' || element.text==='Filtered content');
  assert(generic);
  assert.equal(generic.role,'generic');
  const genericCapture = await runtime.observe({view:'visual',scope:'element',ref:generic.ref});
  assert(genericCapture.visual.bytes>0);
  assert(!genericCapture.snapshot.elements.some(element=>element.ref===generic.ref));
  const excluded = (await runtime.observe()).snapshot.elements.find(element=>element.name==='Name');
  assert(excluded);
  const excludedCapture = await runtime.observe({view:'visual',scope:'element',ref:excluded.ref,maxElements:1});
  assert(excludedCapture.visual.bytes>0);
  assert(!excludedCapture.snapshot.elements.some(element=>element.ref===excluded.ref));
  await js("document.getElementById('filtered').remove()");
  await assert.rejects(runtime.observe({view:'visual',scope:'element',ref:generic.ref}), /stale or unknown/);

  const regressionCdp = controller.cdp.bind(controller);
  for (const change of ['cancel','takeover','navigation']) {
    await controller.runJs("document.body.style.height='2200px';document.getElementById('cross').style.top='1400px';window.scrollTo(0,0)");
    const observed = await runtime.observe();
    const save = observed.snapshot.elements.find(element=>element.name==='Save');
    const abort = new AbortController();
    let interrupted = false;
    controller.cdp = async (method, params, session) => {
      if (method==='DOM.getFrameOwner' && !interrupted) {
        interrupted=true;
        if(change==='cancel') abort.abort(new Error('cancelled geometry'));
        if(change==='takeover') control.pause(control.controlEpoch);
        if(change==='navigation') await js("history.pushState({},'',location.pathname+'#geometry')");
        await wait(100);
      }
      return regressionCdp(method,params,session);
    };
    await assert.rejects(runtime.click({observationId:observed.observationId,expectedControlEpoch:control.controlEpoch,ref:save.ref,signal:abort.signal}), /cancelled|control|changed|observation/);
    await wait(150);
    controller.cdp=regressionCdp;
    assert(interrupted);
    assert.equal(await controller.runJs('scrollY'),0,change+' must not scroll after interruption');
    assert.equal(controller.input.programmaticPressed.size,0);
    if(change==='takeover') control.resume(control.controlEpoch);
  }
  await controller.runJs("document.body.style.height='';document.getElementById('cross').style.top='100px';window.scrollTo(0,0)");
  await runtime.observe();
  await js("document.getElementById('name').focus();window.keyEvents=[];document.addEventListener('keydown',event=>keyEvents.push('down:'+event.key));document.addEventListener('keyup',event=>keyEvents.push('up:'+event.key))");
  let keyNavigated = false;
  const keyRoutes = [];
  controller.cdp = async (method,params,session) => {
    if(method==='Input.dispatchKeyEvent') keyRoutes.push({type:params.type,session});
    const value = await regressionCdp(method,params,session);
    if(method==='Input.dispatchKeyEvent' && params.type==='rawKeyDown' && !keyNavigated) {
      keyNavigated=true;
      await js("history.pushState({},'',location.pathname+'#key')");
      await wait(100);
    }
    return value;
  };
  await assert.rejects(runtime.pressKey(await request({key:'a'})), /changed/);
  await wait(100);
  controller.cdp=regressionCdp;
  assert.deepEqual(await js('keyEvents'),['down:a','up:a']);
  assert.deepEqual(keyRoutes.map(route=>route.type),['rawKeyDown','keyUp']);
  assert(keyRoutes[0].session);
  assert.equal(keyRoutes[0].session,keyRoutes[1].session);
  await js("document.getElementById('name').addEventListener('input',()=>document.body.append(document.getElementById('name').cloneNode()),{once:true})");
  await assert.rejects(runtime.type(await request({locator:locator('name'),text:'abc',replace:false})), /ambiguous locator.*input may have been delivered.*not retried/);
  assert.deepEqual(await js("Array.from(document.querySelectorAll('#name')).map(node=>node.value)"),['a','a']);
  await js("document.querySelectorAll('#name')[1].remove();document.getElementById('name').value=''");

  await runtime.observe({frame:'main'});
  let detachedDuringInit=false;
  controller.cdp=async(method,params,session)=>{
    if(method==='Runtime.enable' && session && !detachedDuringInit) {
      detachedDuringInit=true;
      await controller.runJs("document.getElementById('transient').remove()");
      await wait(100);
    }
    return regressionCdp(method,params,session);
  };
  await controller.runJs(`(()=>{const frame=document.createElement('iframe');frame.id='transient';frame.src='http://127.0.0.2:${server.address().port}/leaf';document.body.append(frame)})()`);
  await wait(1000);
  controller.cdp=regressionCdp;
  assert(detachedDuringInit);
  for(let attempt=0;attempt<3;attempt++) await runtime.observe({frame:'main'});
  await runtime.observe({frame:cross.ref});
  console.log('STAGE click');
  const firstClick=await runtime.click(await request({locator:locator('save')}));
  assert.deepEqual(rootTargets.at(-1),firstClick.point);
  assert.equal(await js('counts.save'),1);
  console.log('STAGE type');
  await runtime.type(await request({locator:locator('name'),text:'frame value',replace:true}));
  assert.equal(await js('document.getElementById("name").value'),'frame value');
  await runtime.type(await request({locator:locator('name'),text:'',replace:true}));
  await runtime.type(await request({locator:locator('name'),text:'natural',replace:false}));
  assert.equal(await js('document.getElementById("name").value'),'natural');
  console.log('STAGE hover');
  await runtime.hover(await request({target:{locator:locator('save')}}));
  assert.equal((await runtime.waitFor(await request({locator:locator('save'),condition:'actionable',timeoutMs:500}))).matched,true);
  console.log('STAGE zoom');
  for(const zoom of [1,1.25,1.5]) {
    controller.window.webContents.setZoomFactor(zoom);
    await wait(150);
    const observation=await runtime.observe({view:'both'});
    const save=observation.snapshot.elements.find(element=>element.name==='Save');
    assert(save);
    const capture=await runtime.observe({view:'both',scope:'element',ref:save.ref});
    const image=nativeImage.createFromBuffer(capture.visual.data),pixels=image.toBitmap();
    let red=0;
    for(let index=0;index<pixels.length;index+=4) if(pixels[index]===0&&pixels[index+1]===0&&pixels[index+2]===255) red++;
    assert(red>pixels.length/12,'element capture must contain red button pixels');
    await runtime.click(await request({locator:locator('save')}));
    assert.equal(await js('counts.save'),[1,1.25,1.5].indexOf(zoom)+2);
  }
  controller.window.webContents.setZoomFactor(1);
  await wait(150);
  const filename=join(directory,'frame-upload.txt');writeFileSync(filename,'frame file');
  await runtime.upload(await request({locator:locator('file'),files:[filename]}), directory);
  assert.equal(await js('file.files[0].name'),'frame-upload.txt');
  console.log('STAGE child-dialog');
  const prompted=js("prompt('frame prompt','default')");
  for(let attempt=0;!controller.dialogs.pending;attempt++) {if(attempt>100) throw new Error('child prompt timed out');await wait(10);}
  const dialog=controller.dialogs.pending;
  assert.equal(dialog.message,'frame prompt');
  await controller.dialogs.respond({dialogId:dialog.id,expectedControlEpoch:control.controlEpoch,accept:true,text:'child response'});
  assert.equal(await prompted,'child response');
  assert.equal(await js('debugger; 42'),42);
  console.log('STAGE same-frame-drag');
  await runtime.drag(await request({from:{locator:locator('drag')},to:{locator:locator('drop')},button:'left'}));
  const htmlDropCount=await js('counts.drop');

  const nested=(await runtime.observe()).frames.find(frame=>frame.name==='nested');
  assert(nested,'nested frame must be listed');
  await runtime.observe({frame:nested.ref});
  assert(controller.frames.selectedFrame().session,'nested different-site frame must use a session');
  await runtime.click(await request({locator:locator('save')}));
  assert.equal(await js('counts.save'),1);
  await runtime.observe({frame:cross.ref});
  assert(await js('document.getElementById("scroll").scrollTop>0'));
  await assert.rejects(runtime.drag(await request({from:{locator:locator('drag')},to:{ref:main.snapshot.elements[0].ref},button:'left'})),/cross-frame|stale or unknown ref/);
  console.log('STAGE same-origin-nested');
  const sameNested=(await runtime.observe()).frames.find(frame=>frame.name==='same-nested');assert(sameNested);
  await runtime.observe({frame:sameNested.ref});
  const sameNestedSession=controller.frames.selectedFrame().session;
  assert.equal(sameNestedSession,controller.frames.chain().at(-2).session);
  await runtime.click(await request({locator:locator('save')}));
  assert.equal(await js('counts.save'),1);
  await runtime.observe({frame:cross.ref});
  console.log('STAGE geometry-takeover');
  const visual=await runtime.observe({view:'both'});
  const visualSave=visual.snapshot.elements.find(element=>element.name==='Save');
  await controller.runJs("document.getElementById('cross').style.left='130px'");
  await assert.rejects(runtime.hover({observationId:visual.observationId,expectedControlEpoch:control.controlEpoch,target:{x:visualSave.rect.x+20,y:visualSave.rect.y+15}}),/geometry changed/);
  await controller.runJs("document.getElementById('cross').style.transform='rotate(2deg)'");
  await assert.rejects(runtime.observe(),error=>{
    assert.equal(error.message,'Error: unsupported frame owner transform');
    return true;
  });
  await controller.runJs("document.getElementById('cross').style.transform='none'");
  const beforeTakeover=await js('counts.save');
  const originalPointer=controller.agentPointer.bind(controller);
  let taken=false;
  controller.agentPointer=event=>{originalPointer(event);if(event.kind==='move'&&!taken){taken=true;control.pause(control.controlEpoch);}};
  await assert.rejects(runtime.click(await request({locator:locator('save')})),/control|observation/);
  controller.agentPointer=originalPointer;
  assert.equal(await js('counts.save'),beforeTakeover);
  assert.equal(controller.input.programmaticPressed.size,0);
  control.resume(control.controlEpoch);
  let pressed=false,dragTaken=false;
  controller.agentPointer=event=>{originalPointer(event);if(event.kind==='down')pressed=true;if(event.kind==='move'&&pressed&&!dragTaken){dragTaken=true;control.pause(control.controlEpoch);}};
  await assert.rejects(runtime.drag(await request({from:{locator:locator('drag')},to:{locator:locator('drop')},button:'left'})),/control|observation/);
  controller.agentPointer=originalPointer;
  assert.equal(controller.input.programmaticPressed.size,0);
  assert.equal(await js('counts.drop'),htmlDropCount);
  control.resume(control.controlEpoch);
  await runtime.click(await request({locator:locator('save')}));
  assert.equal(await js('counts.save'),beforeTakeover+1);
  console.log('STAGE swap');
  const staleSwap=await request({locator:locator('save')});
  await controller.runJs("document.getElementById('cross').src='/leaf'");await wait(250);
  await assert.rejects(runtime.click(staleSwap),/stale|changed|detached/);
  const swappedMain=await runtime.observe({frame:'main'});
  const swapped=swappedMain.frames.find(frame=>frame.name==='cross');assert(swapped);
  await runtime.observe({frame:swapped.ref});
  assert.equal(controller.frames.selectedFrame().session,'');
  await runtime.click(await request({locator:locator('save')}));
  assert.equal(await js('counts.save'),1);
  const stale=await request({locator:locator('save')});
  await controller.runJs('document.getElementById("cross").remove()');await wait(100);
  await assert.rejects(runtime.click(stale),/stale|changed|detached/);
  const restored=await runtime.observe({frame:'main'});
  assert(!restored.frames.some(frame=>frame.ref===cross.ref));
  console.log('STAGE popup');
  let popup;
  controller.onPopupCreated=value=>{popup=value;popupRuntime=new BrowserAgentRuntime(value,{control,personaProvider:()=>persona,onActivityChange:activity=>{if(activity?.target)popupTargets.push(activity.target);}});value.onMainFrameNavigationStart=()=>popupRuntime.invalidateDocument();};
  await runtime.click(await request({locator:locator('open')}));
  for(let attempt=0;!popup || !await popup.runJs('window.ready===true').catch(()=>false);attempt++) {if(attempt>300) throw new Error('popup timed out');await wait(10);}
  const popupMain=await popupRuntime.observe({frame:'main'});
  const popupCross=popupMain.frames.find(frame=>frame.name==='cross');assert(popupCross);
  await popupRuntime.observe({frame:popupCross.ref});
  popup.window.webContents.setZoomFactor(1.25);await wait(150);
  const popupObservation=await popupRuntime.observe({view:'both'});
  const popupSave=popupObservation.snapshot.elements.find(element=>element.name==='Save');assert(popupSave);
  const popupClick=await popupRuntime.click({observationId:popupObservation.observationId,expectedControlEpoch:control.controlEpoch,ref:popupSave.ref});
  assert.deepEqual(popupTargets.at(-1),popupClick.point);
  assert.equal(await popup.frames.evaluate('counts.save'),1);
  const popupCapture=await popupRuntime.observe({view:'both',scope:'element',ref:popupSave.ref});
  const popupPixels=nativeImage.createFromBuffer(popupCapture.visual.data).toBitmap();let popupRed=0;
  for(let index=0;index<popupPixels.length;index+=4) if(popupPixels[index]===0&&popupPixels[index+1]===0&&popupPixels[index+2]===255) popupRed++;
  assert(popupRed>popupPixels.length/12);
  assert.equal(await popup.runJs('!!opener'),true);
  popup.destroy();
  assert.equal(htmlDropCount,1,'same-frame HTML5 drag must drop exactly once');
  console.log(JSON.stringify({frames:'passed' ,electron:process.versions.electron,oopif:true,zoom:true,upload:true}));
  controller.stop();server.close();app.quit();
})().catch(error=>{console.error(error);controller?.stop();server.close();app.exit(1)});
app.once('will-quit',()=>rmSync(directory,{recursive:true,force:true}));
