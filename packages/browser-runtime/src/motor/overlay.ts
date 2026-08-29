export interface OverlayIdentity { hostId: string; setterName: string; installerName: string }

export function overlayInstallSource(identity: OverlayIdentity): string {
  const key = JSON.stringify(identity.hostId);
  const setter = JSON.stringify(identity.setterName);
  const installer = JSON.stringify(identity.installerName);
  return `(() => {
    const key=${key}, setter=${setter}, installer=${installer};
    let root;
    const install=()=>{
      let host=document.getElementById(key);
      if(!host){
        host=document.createElement('div'); host.id=key; host.setAttribute('aria-hidden','true');
        host.style.cssText='all:initial;position:fixed;left:0;top:0;width:24px;height:30px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.85));will-change:transform';
        root=host.attachShadow({mode:'closed'});
        const style=document.createElement('style'); style.textContent=':host{all:initial}.cursor{width:22px;height:28px;background:#ff2d55;clip-path:polygon(0 0,0 85%,27% 64%,43% 100%,56% 94%,40% 59%,76% 58%);outline:1px solid white}';
        const cursor=document.createElement('div'); cursor.className='cursor'; root.append(style,cursor);
        (document.documentElement||document.body).appendChild(host);
      }
      const state=globalThis[key]||{x:80,y:80,pathSequence:0,sampleSequence:0}; globalThis[key]=state;
      host.style.transform='translate('+(state.x-1)+'px,'+(state.y-1)+'px)'; host.dataset.pathSequence=String(state.pathSequence); host.dataset.sampleSequence=String(state.sampleSequence);
      return true;
    };
    Object.defineProperty(globalThis,installer,{value:install,configurable:true});
    Object.defineProperty(globalThis,setter,{value:(x,y,pathSequence,sampleSequence)=>{ install(); const state=globalThis[key]; Object.assign(state,{x,y,pathSequence,sampleSequence}); const host=document.getElementById(key); host.style.transform='translate('+(x-1)+'px,'+(y-1)+'px)'; host.dataset.pathSequence=String(pathSequence); host.dataset.sampleSequence=String(sampleSequence); return true; },configurable:true});
    if(document.documentElement) install(); else addEventListener('DOMContentLoaded',install,{once:true});
    new MutationObserver(()=>{ if(document.documentElement&&!document.getElementById(key)) install(); }).observe(document,{childList:true,subtree:true});
    return true;
  })()`;
}

export function overlayUpdateSource(identity: OverlayIdentity, x: number, y: number, pathSequence: number, sampleSequence: number): string {
  return `globalThis[${JSON.stringify(identity.setterName)}]?.(${number(x)},${number(y)},${pathSequence},${sampleSequence})`;
}

export function overlayVerifySource(identity: OverlayIdentity): string {
  return `Boolean(globalThis[${JSON.stringify(identity.installerName)}]?.() && document.getElementById(${JSON.stringify(identity.hostId)}))`;
}

function number(value: number): string { if (!Number.isFinite(value)) throw new Error("Overlay coordinate is not finite."); return String(value); }
