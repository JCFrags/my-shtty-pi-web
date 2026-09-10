const http = require('node:http');
const style = `<style>body{font:18px sans-serif;background:#f4f7fa;color:#18232e;margin:24px}button,input{font:inherit;padding:10px;margin:8px}section{display:inline-block;border:2px solid #8095ad;padding:12px;margin:8px}iframe{display:block;width:90%;height:270px;border:6px solid #3674ad;margin-top:20px}output{display:block;padding:8px;color:#175b28}.cover{position:fixed;inset:0;background:#d8e5f7e8;display:grid;place-items:center;z-index:20}</style>`;
function start(port = 0) {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/download') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="same.txt"');
      res.end('download fixture');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/embedded') {
      res.end(`<!doctype html>${style}<h2>Embedded contact form</h2><label>Contact name<input placeholder="Your name"></label><button disabled id="submit">Submit embedded</button><output id="result">Waiting for name</output><script>const input=document.querySelector('input'),button=document.querySelector('button');let count=0;input.oninput=()=>{button.disabled=true;setTimeout(()=>{button.disabled=!input.value},900)};button.onclick=()=>{count++;document.querySelector('output').textContent='Submitted '+input.value+' — count '+count}</script>`);
    } else {
      res.end(`<!doctype html>${style}<h1>Dynamic targeting check</h1><section aria-label="Left card"><h2>Left card</h2><button onclick="this.nextElementSibling.textContent='Left count '+(++window.leftCount)">Choose</button><output>Left count 0</output></section><section aria-label="Right card"><h2>Right card</h2><button onclick="this.nextElementSibling.textContent='Right count '+(++window.rightCount)">Choose</button><output>Right count 0</output></section><div><button id="prepare">Prepare delayed control</button><button id="delayed" disabled>Delayed action</button><output id="state">Not started</output></div><button onclick="window.open('/popup','dynamic-popup','width=850,height=700')">Open frame popup</button><a href="/download">Download fixture</a><iframe name="contact-form" title="Contact form" src="http://localhost:${port}/embedded"></iframe><script>window.leftCount=0;window.rightCount=0;let count=0;document.querySelector('#prepare').onclick=()=>{const b=document.querySelector('#delayed');b.disabled=true;const cover=document.createElement('div');cover.className='cover';cover.textContent='Loading: wait for the control';document.body.append(cover);setTimeout(()=>{cover.remove();const replacement=b.cloneNode(true);b.replaceWith(replacement);replacement.disabled=false;replacement.onclick=()=>document.querySelector('#state').textContent='Delayed count '+(++count)},1800)};</script>`);
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}
module.exports = { start };
if (require.main === module) start(Number(process.argv[2] || 0)).then(server => console.log(`http://127.0.0.1:${server.address().port}/`));
