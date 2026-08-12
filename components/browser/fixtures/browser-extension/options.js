const enabled=document.querySelector('#enabled');chrome.storage.local.get({enabled:true},v=>enabled.checked=v.enabled);enabled.onchange=()=>chrome.storage.local.set({enabled:enabled.checked});
