// Local, login-free replica of the a cloud-certification practice-test site practice-test flow used by
// bench/scenario.mjs (the live test needs a login in a fresh profile).
//
//   home  /r/<run>/                   link a[href$="/c/web-101/41"]
//   test  /r/<run>/c/web-101/41       "Exam mode" (decoy) + "Practice: Reveal the answer ..." button
//   play  (same page, client-side)    #qmain "Question N of M", .qhtml, #optList .opt[data-key],
//                                     button[data-act=reveal], then button[data-nav=next]
//   end   (same page)                 "Score: S / M", input#name, button#submit -> #saved
//
// Questions are fetched from the server with a fixed delay (default 60 ms) so waits are real.
// The page reports every step to the server (sendBeacon/fetch), so checkpoints are verified
// out of band, identically for both browsers, without extra driver calls.
//
// Per-run options (POST /api/runs {pause, questions, seed, delayMs}):
//   pause: the page pauses when it loses focus/visibility and polls document.hasFocus()
//          every 400 ms, like the live site ("paused while you were away" + button[data-resume]).
import http from 'node:http';

const runs = new Map(); // id -> { cfg, events: [] }

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function questionsFor(seed, n) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = 10 + Math.floor(r() * 80);
    const b = 10 + Math.floor(r() * 80);
    const sum = a + b;
    const vals = new Set([sum]);
    while (vals.size < 4) vals.add(sum + (Math.floor(r() * 21) - 10 || 11));
    const opts = [...vals].sort(() => r() - 0.5);
    const keys = ['A', 'B', 'C', 'D'];
    out.push({
      n: i + 1,
      text: `A queue holds ${a} objects and ${b} more are uploaded. What is ${a} + ${b}?`,
      options: opts.map((v, j) => ({ key: keys[j], text: String(v) })),
      answer: keys[opts.indexOf(sum)],
      explain: `${a} + ${b} = ${sum}.`,
    });
  }
  return out;
}

const css = `body{font:16px system-ui,sans-serif;margin:0;padding:24px;background:#0f1117;color:#eef}
a{color:#9cf} .card{background:#1b1e2a;border-radius:12px;padding:20px;margin:0 0 16px;max-width:760px}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #4b6bfb;background:#2d3a8c;color:#fff;cursor:pointer;margin:4px}
.opt{display:block;width:100%;text-align:left;background:#22263a;border-color:#444}
.opt.selected{border-color:#ffd23f}.opt.correct{background:#1e5f35}.opt.wrong{background:#6b1f1f}
#pause{position:fixed;inset:0;background:rgba(0,0,0,.8);display:none;align-items:center;justify-content:center;flex-direction:column;z-index:10}
input{font:inherit;padding:8px;border-radius:8px;border:1px solid #555;background:#111;color:#fff}`;

function page(run, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Practice exams</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
${body}
<script>
const RUN=${JSON.stringify(run)};
const ev=(type,data={})=>fetch('/api/'+RUN+'/event',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,...data,t:Date.now()}),keepalive:true});
${script}
</script></body></html>`;
}

function home(run) {
  return page(run, `<h1>Practice exams</h1>
<div class="card"><h2>Web Fundamentals (WEB-101)</h2>
<p><a href="/r/${run}/c/web-101/40">WEB-101 Practice Test 00</a></p>
<p><a href="/r/${run}/c/web-101/41">WEB-101 Practice Test 01</a></p>
<p><a href="/r/${run}/c/web-101/42">WEB-101 Practice Test 02</a></p></div>`, `ev('view_home');`);
}

function testPage(run, cfg, testId) {
  return page(run, `<h1 id="ttl">WEB-101 Practice Test ${String(testId - 40).padStart(2, '0')}</h1>
<div id="pause"><p>Paused while you were away.</p><button data-resume>Resume</button></div>
<div class="card" id="intro"><p>${cfg.questions} questions. Choose a mode.</p>
<button data-mode="exam">Exam mode: score at the end</button>
<button data-mode="practice">Practice mode: Reveal the answer after each question</button></div>
<div class="card" id="qmain" hidden></div>
<div class="card" id="result" hidden></div>`, `
ev('view_test',{test:${testId}});
const PAUSE=${cfg.pause ? 'true' : 'false'}, TOTAL=${cfg.questions};
let cur=0, sel=null, score=0, playing=false, paused=false;
const $=(s)=>document.querySelector(s);
function setPaused(p,why){ if(!PAUSE||!playing||p===paused) return; paused=p; $('#pause').style.display=p?'flex':'none'; ev(p?'pause':'resume',{why,q:cur}); }
if(PAUSE){
  addEventListener('blur',()=>setPaused(true,'blur'));
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) setPaused(true,'hidden'); });
  setInterval(()=>{ if(!document.hasFocus()) setPaused(true,'poll'); },400);
}
$('[data-resume]').addEventListener('click',()=>setPaused(false,'click'));
async function load(n){
  const q=await (await fetch('/api/'+RUN+'/q/'+n)).json();
  cur=n; sel=null;
  $('#qmain').innerHTML='<p id="qnum">Question '+n+' of '+TOTAL+'</p><div class="qhtml">'+q.text+'</div><div id="optList">'+
    q.options.map(o=>'<button class="opt" data-key="'+o.key+'">'+o.key+'. '+o.text+'</button>').join('')+
    '</div><div id="revealZone"><button data-act="reveal">Show answer</button></div><div id="after"></div>';
  for(const b of document.querySelectorAll('#optList .opt')) b.addEventListener('click',()=>{
    if(paused) return; sel=b.dataset.key; for(const x of document.querySelectorAll('#optList .opt')) x.classList.toggle('selected',x===b); ev('select',{q:n,key:sel,trusted:event.isTrusted});
  });
  $('[data-act=reveal]').addEventListener('click',async()=>{
    if(paused) return;
    const r=await (await fetch('/api/'+RUN+'/reveal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({q:n,key:sel})})).json();
    if(r.correct) score++;
    for(const x of document.querySelectorAll('#optList .opt')){ if(x.dataset.key===r.answer) x.classList.add('correct'); else if(x.dataset.key===sel) x.classList.add('wrong'); }
    $('#revealZone').innerHTML='';
    $('#after').innerHTML='<p id="verdict">'+(r.correct?'Correct.':'Incorrect.')+' '+r.explain+'</p><button data-nav="next">'+(n<TOTAL?'Next question':'See results')+'</button>';
    $('[data-nav=next]').addEventListener('click',()=>{ if(paused) return; n<TOTAL?load(n+1):results(); });
  });
  ev('view_q',{q:n});
}
function results(){
  playing=false; $('#qmain').hidden=true; const el=$('#result'); el.hidden=false;
  el.innerHTML='<h2 id="score">Score: '+score+' / '+TOTAL+'</h2><label>Your name <input id="name" placeholder="name for the leaderboard"></label> <button id="submit">Submit score</button><p id="saved"></p>';
  $('#submit').addEventListener('click',async()=>{ const name=$('#name').value; await fetch('/api/'+RUN+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,score})}); $('#saved').textContent='Saved: '+name+' ('+score+' / '+TOTAL+')'; });
  ev('view_results',{score});
}
document.querySelector('[data-mode=exam]').addEventListener('click',()=>{ ev('wrong_mode'); });
document.querySelector('[data-mode=practice]').addEventListener('click',()=>{ $('#intro').hidden=true; $('#qmain').hidden=false; playing=true; ev('start'); load(1); });
`);
}

const json = (res, code, v) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(v));
};
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startQuizServer(port = 8766) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    let m;
    if (req.method === 'POST' && p === '/api/runs') {
      const o = await body(req);
      const id = o.id || Math.random().toString(36).slice(2, 10);
      const cfg = { pause: !!o.pause, questions: o.questions ?? 5, seed: o.seed ?? 1, delayMs: o.delayMs ?? 60 };
      runs.set(id, { cfg, qs: questionsFor(cfg.seed, cfg.questions), events: [] });
      return json(res, 200, { id, cfg });
    }
    if ((m = /^\/api\/runs\/([\w-]+)$/.exec(p))) {
      const r = runs.get(m[1]);
      return r ? json(res, 200, { cfg: r.cfg, answers: r.qs.map((q) => q.answer), events: r.events }) : json(res, 404, {});
    }
    if ((m = /^\/api\/([\w-]+)\/(event|q|reveal|submit)(?:\/(\d+))?$/.exec(p))) {
      const r = runs.get(m[1]);
      if (!r) return json(res, 404, { error: 'unknown run' });
      if (m[2] === 'q') {
        await sleep(r.cfg.delayMs);
        const q = r.qs[Number(m[3]) - 1];
        if (!q) return json(res, 404, {});
        const { answer, explain, ...pub } = q;
        return json(res, 200, pub);
      }
      const o = await body(req);
      if (m[2] === 'event') { r.events.push({ ...o, srv: Date.now() }); return json(res, 200, { ok: true }); }
      if (m[2] === 'reveal') {
        await sleep(r.cfg.delayMs);
        const q = r.qs[o.q - 1];
        const correct = !!q && o.key === q.answer;
        r.events.push({ type: 'reveal', q: o.q, key: o.key ?? null, correct, srv: Date.now() });
        return json(res, 200, { correct, answer: q?.answer, explain: q?.explain });
      }
      if (m[2] === 'submit') { r.events.push({ type: 'submit', name: o.name, score: o.score, srv: Date.now() }); return json(res, 200, { ok: true }); }
    }
    if (p === '/sentinel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>sentinel</title><button id=a>a</button> <button id=b>b</button><p id=o></p><script>a.onclick=b.onclick=(e)=>o.textContent+=e.target.id</script>');
    }
    if ((m = /^\/r\/([\w-]+)\/(?:c\/web-101\/(\d+))?$/.exec(p))) {
      const r = runs.get(m[1]);
      if (!r) { res.writeHead(404); return res.end('unknown run'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(m[2] ? testPage(m[1], r.cfg, Number(m[2])) : home(m[1]));
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** Driver-independent checkpoints for one run, from the page's own reports. */
export function checkpoints(state, expectName) {
  const ev = state.events;
  const has = (f) => ev.some(f);
  const cps = [
    ['home_loaded', has((e) => e.type === 'view_home')],
    ['test_page', has((e) => e.type === 'view_test' && e.test === 41)],
    ['practice_started', has((e) => e.type === 'start') && !has((e) => e.type === 'wrong_mode')],
  ];
  for (let q = 1; q <= state.cfg.questions; q++) {
    const reveals = ev.filter((e) => e.type === 'reveal' && e.q === q);
    cps.push([`q${q}_correct`, reveals.length === 1 && reveals[0].correct]);
  }
  cps.push(['results_full_score', has((e) => e.type === 'view_results' && e.score === state.cfg.questions)]);
  cps.push(['score_submitted', has((e) => e.type === 'submit' && e.name === expectName && e.score === state.cfg.questions)]);
  return cps.map(([name, ok]) => ({ name, ok }));
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 8766);
  await startQuizServer(port);
  console.log(`quiz on http://127.0.0.1:${port}  (POST /api/runs to create a run)`);
}
