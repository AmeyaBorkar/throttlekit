/**
 * The Lens UI — a single self-contained static page (no build step, no CDN, no framework). Phase 2 ships a
 * clean, functional board: the binding-axis "why denied" bars (the hero in simple form), a per-policy table,
 * concurrency-guard health, and a live denial feed over SSE (polling fallback). Phase 3 upgrades the hero to
 * a hand-rolled SVG Sankey + the full panel set.
 *
 * The page is base-path agnostic: {@link renderLensHtml} injects the mount base so the API calls resolve
 * whether mounted at `/__throttlekit` in your app or served at `/` by the sidecar.
 */

/** Render the static HTML, baking in the API base path. */
export function renderLensHtml(basePath: string): string {
  return LENS_HTML.replace(/__LENS_BASE__/g, basePath);
}

const LENS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ThrottleKit Lens</title>
<style>
  :root { color-scheme: dark; --bg:#0b0e14; --panel:#141a24; --line:#222b3a; --fg:#e6edf3; --muted:#8b98a9;
    --rate:#4f9cff; --concurrency:#36c692; --cost:#e0b341; --policy:#b47cf0; --deny:#ff5d6c; --allow:#36c692; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--deny); }
  .dot.live { background:var(--allow); }
  .muted { color:var(--muted); }
  main { padding:18px; display:grid; gap:18px; max-width:1100px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  .bar { display:flex; height:14px; border-radius:4px; overflow:hidden; background:#0c1118; min-width:120px; }
  .seg { height:100%; }
  .seg.rate{background:var(--rate)} .seg.concurrency{background:var(--concurrency)} .seg.cost{background:var(--cost)} .seg.policy{background:var(--policy)}
  .chip { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; }
  .chip.rate{background:rgba(79,156,255,.18);color:var(--rate)} .chip.concurrency{background:rgba(54,198,146,.18);color:var(--concurrency)}
  .chip.cost{background:rgba(224,179,65,.18);color:var(--cost)} .chip.policy{background:rgba(180,124,240,.18);color:var(--policy)}
  .legend span { margin-right:14px; font-size:12px; }
  .sw { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .feed { max-height:260px; overflow:auto; }
  .empty { color:var(--muted); padding:8px; }
  code { color:var(--fg); }
</style>
</head>
<body>
<header>
  <h1>ThrottleKit <span style="color:var(--rate)">Lens</span></h1>
  <span id="conn" class="dot"></span>
  <span id="meta" class="muted"></span>
  <span style="flex:1"></span>
  <span class="legend muted">
    <span><i class="sw" style="background:var(--rate)"></i>rate</span>
    <span><i class="sw" style="background:var(--concurrency)"></i>concurrency</span>
    <span><i class="sw" style="background:var(--cost)"></i>cost</span>
    <span><i class="sw" style="background:var(--policy)"></i>policy</span>
  </span>
</header>
<main>
  <div class="panel">
    <h2>Why are requests denied? &mdash; binding axis</h2>
    <div id="hero"></div>
  </div>
  <div class="panel">
    <h2>Policies</h2>
    <div id="policies"></div>
  </div>
  <div class="panel">
    <h2>Concurrency &amp; fleet health</h2>
    <div id="guards"></div>
  </div>
  <div class="panel">
    <h2>Live denials</h2>
    <div id="feed" class="feed"></div>
  </div>
</main>
<script>
"use strict";
var BASE = "__LENS_BASE__";
var LANES = ["rate","concurrency","cost","policy"];
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); }
function el(id){ return document.getElementById(id); }

function isAdmitter(p){ return p.kind === "admitter"; }
function deniesByLane(p){ return (p.analytics && p.analytics.deniedByLane) || {}; }

function renderHero(snap){
  var admitters = snap.policies.filter(isAdmitter);
  if(!admitters.length){ el("hero").innerHTML = '<div class="empty">No unified-admission policies. The full board below works for every limiter; configure <code>unifiedAdmission</code> to light up the rate/concurrency/cost axis breakdown.</div>'; return; }
  var rows = admitters.map(function(p){
    var d = deniesByLane(p); var total = LANES.reduce(function(s,l){ return s + (d[l]||0); },0);
    var segs = LANES.map(function(l){ var n=d[l]||0; var w = total? (100*n/total):0; return n? '<div class="seg '+l+'" style="width:'+w+'%" title="'+l+': '+n+'"></div>':''; }).join("");
    var labels = LANES.filter(function(l){ return d[l]; }).map(function(l){ return '<span class="chip '+l+'">'+l+' '+d[l]+'</span>'; }).join(" ");
    return '<tr><td><code>'+esc(p.name)+'</code></td><td style="width:45%"><div class="bar">'+segs+'</div></td><td>'+(total||'<span class="muted">0</span>')+'</td><td>'+labels+'</td></tr>';
  }).join("");
  el("hero").innerHTML = '<table><thead><tr><th>policy</th><th>binding axis (of denials)</th><th>denied</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderPolicies(snap){
  if(!snap.policies.length){ el("policies").innerHTML = '<div class="empty">No policies tracked yet.</div>'; return; }
  var rows = snap.policies.map(function(p){
    var a = p.analytics || {}; var top = (a.topDenied||[]).slice(0,3).map(function(h){ return esc(h.key)+":"+h.count; }).join(", ");
    var kind = p.kind === "admitter" ? "admitter" : ("limiter"+(p.strategy?(" ("+esc(p.strategy)+")"):""));
    return '<tr><td><code>'+esc(p.name)+'</code></td><td class="muted">'+kind+'</td><td>'+(a.allowed||0)+'</td><td>'+(a.denied||0)+'</td><td>'+(a.total?Math.round(100*(a.denyRate||0))+'%':'&mdash;')+'</td><td class="muted">'+(top||'&mdash;')+'</td></tr>';
  }).join("");
  el("policies").innerHTML = '<table><thead><tr><th>name</th><th>kind</th><th>allowed</th><th>denied</th><th>deny%</th><th>top denied keys</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderGuards(snap){
  if(!snap.guards.length){ el("guards").innerHTML = '<div class="empty">No concurrency guards tracked.</div>'; return; }
  var rows = snap.guards.map(function(g){
    var fenced = g.fenced ? '<span class="chip policy">FENCED</span>' : '<span class="muted">ok</span>';
    var fleet = (g.nodes!=null) ? (g.share+'/'+g.lGlobal+' &middot; '+g.nodes+' nodes') : '<span class="muted">single</span>';
    return '<tr><td><code>'+esc(g.name)+'</code></td><td>'+g.inflight+' / '+g.limit+'</td><td>'+Math.round(g.rttNoload)+'ms</td><td>'+fleet+'</td><td>'+fenced+'</td></tr>';
  }).join("");
  el("guards").innerHTML = '<table><thead><tr><th>guard</th><th>inflight/limit</th><th>noload rtt</th><th>fleet</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
}

var feed = [];
function pushDenial(row){ feed.unshift(row); if(feed.length>50) feed.pop(); renderFeed(); }
function renderFeed(){
  if(!feed.length){ el("feed").innerHTML = '<div class="empty">Waiting for denials&hellip;</div>'; return; }
  el("feed").innerHTML = feed.map(function(r){
    var lane = r.lane ? '<span class="chip '+r.lane+'">'+r.lane+'</span>' : '<span class="muted">policy</span>';
    var t = new Date(r.at).toLocaleTimeString();
    return '<div>'+'<span class="muted">'+t+'</span> '+lane+' <code>'+esc(r.policy)+'</code> <span class="muted">key</span> <code>'+esc(r.key||'(global)')+'</code></div>';
  }).join("");
}

function renderAll(snap){
  var m = snap.meta||{}; el("meta").textContent = (m.mode||"process")+" \\u00b7 window "+Math.round((m.windowMs||0)/1000)+"s"+(m.nodeId?(" \\u00b7 "+m.nodeId):"");
  renderHero(snap); renderPolicies(snap); renderGuards(snap);
  if(snap.recentDenials && !feed.length){ feed = snap.recentDenials.slice().reverse().slice(0,50); renderFeed(); }
}
function setConn(live){ el("conn").className = "dot"+(live?" live":""); }

function connect(){
  try {
    var es = new EventSource(BASE+"/api/stream");
    es.addEventListener("snapshot", function(e){ setConn(true); renderAll(JSON.parse(e.data)); });
    es.addEventListener("denial", function(e){ pushDenial(JSON.parse(e.data)); });
    es.onerror = function(){ setConn(false); };
  } catch(_) { poll(); }
}
function poll(){ fetch(BASE+"/api/snapshot").then(function(r){return r.json();}).then(function(s){ setConn(true); renderAll(s); }).catch(function(){ setConn(false); }); setInterval(function(){ fetch(BASE+"/api/snapshot").then(function(r){return r.json();}).then(renderAll).catch(function(){ setConn(false); }); }, 2000); }

if(window.EventSource){ connect(); } else { poll(); }
</script>
</body>
</html>`;
