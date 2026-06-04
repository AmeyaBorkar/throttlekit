/**
 * The Lens UI — a single self-contained static page (no build step, no CDN, no framework). The hero is a
 * hand-rolled SVG **Sankey** (binding axis → top-denied keys) beside a stacked-area **deny-rate timeline**;
 * clicking a denial opens a drawer with the exact per-axis `Decision` ("why throttled, with numbers"). Below
 * it: the conventional ops board (throughput, deny rate, top keys, latency, concurrency health + a live
 * fence feed), a first-class **Guarantee** panel (per-policy headroom + live `Σinflight ≤ L` invariant chips
 * + a static link to the TLA⁺-proven overshoot bound), fairness, store/fleet health, and a live denial feed.
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
    --rate:#4f9cff; --concurrency:#36c692; --cost:#e0b341; --policy:#b47cf0; --limiter:#5a6b82; --deny:#ff5d6c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  a { color:var(--rate); }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  header h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--deny); }
  .dot.live { background:var(--concurrency); }
  .muted { color:var(--muted); }
  main { padding:18px; display:grid; gap:18px; max-width:1180px; }
  .grid2 { display:grid; grid-template-columns:1.4fr 1fr; gap:18px; }
  @media (max-width:840px){ .grid2{ grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; min-width:0; }
  .panel h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; }
  .bar { display:flex; height:13px; border-radius:4px; overflow:hidden; background:#0c1118; min-width:110px; }
  .seg { height:100%; }
  .seg.rate{background:var(--rate)} .seg.concurrency{background:var(--concurrency)} .seg.cost{background:var(--cost)} .seg.policy{background:var(--policy)} .seg.limiter{background:var(--limiter)}
  .chip { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; }
  .chip.rate{background:rgba(79,156,255,.18);color:var(--rate)} .chip.concurrency{background:rgba(54,198,146,.18);color:var(--concurrency)}
  .chip.cost{background:rgba(224,179,65,.18);color:var(--cost)} .chip.policy{background:rgba(180,124,240,.18);color:var(--policy)}
  .chip.fail{background:rgba(255,93,108,.18);color:var(--deny)}
  .legend span { margin-right:14px; font-size:12px; } .sw { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .feed { max-height:280px; overflow:auto; } .feed .row { cursor:pointer; padding:2px 4px; border-radius:4px; } .feed .row:hover { background:#0c1118; }
  .empty { color:var(--muted); padding:8px; }
  code { color:var(--fg); }
  svg.sankey text.snode { fill:var(--fg); font-size:11px; } svg.sankey text.knode { fill:var(--muted); font-size:11px; }
  .band { fill:none; opacity:.34; } .band.rate{stroke:var(--rate)} .band.concurrency{stroke:var(--concurrency)} .band.cost{stroke:var(--cost)} .band.policy{stroke:var(--policy)} .band.limiter{stroke:var(--limiter)}
  .area { opacity:.55; } .area.rate{fill:var(--rate)} .area.concurrency{fill:var(--concurrency)} .area.cost{fill:var(--cost)} .area.policy{fill:var(--policy)} .area.limiter{fill:var(--limiter)}
  #drawer { display:none; position:fixed; right:18px; bottom:18px; width:360px; max-width:92vw; background:#0f1622; border:1px solid var(--line); border-radius:10px; padding:14px; box-shadow:0 10px 40px rgba(0,0,0,.5); z-index:20; }
  #drawer .close { float:right; cursor:pointer; color:var(--muted); }
  .drawer-h { margin-bottom:8px; }
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
  <div class="grid2">
    <div class="panel">
      <h2>Why are requests denied? &mdash; binding axis &rarr; top keys</h2>
      <div id="sankey"></div>
      <div id="heroEmpty"></div>
    </div>
    <div class="panel">
      <h2>Deny rate over time (by axis)</h2>
      <div id="timeline"></div>
      <div id="throughput" class="muted" style="margin-top:8px"></div>
    </div>
  </div>
  <div class="panel"><h2>Guarantee &mdash; headroom &amp; live invariants</h2><div id="guarantee"></div></div>
  <div class="panel"><h2>Policies</h2><div id="policies"></div></div>
  <div class="grid2">
    <div class="panel"><h2>Concurrency &amp; fleet health</h2><div id="guards"></div><div id="fences" style="margin-top:8px"></div></div>
    <div class="panel"><h2>Fairness &amp; custom stats</h2><div id="stats"></div></div>
  </div>
  <div class="panel"><h2>Live denials <span class="muted">(click a row for the per-axis decision)</span></h2><div id="feed" class="feed"></div></div>
  <div class="panel" id="healthPanel" style="display:none"><h2>Store / fleet</h2><div id="health"></div></div>
</main>
<div id="drawer"></div>
<script>
"use strict";
var BASE = "__LENS_BASE__";
var SPEC = "https://github.com/AmeyaBorkar/throttlekit/blob/main/spec/DistributedLeasing.tla";
var LANES = ["rate","concurrency","cost","policy"];
var SERIES = ["rate","concurrency","cost","policy","limiter"];
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"})[c]; }); }
function el(id){ return document.getElementById(id); }
function isAdmitter(p){ return p.kind === "admitter"; }
function dbl(p){ return (p.analytics && p.analytics.deniedByLane) || {}; }
function tdbl(p){ return (p.analytics && p.analytics.topDeniedByLane) || {}; }

/* ---- hero: build flows (sources -> keys) ---- */
function heroFlows(snap){
  var admitters = snap.policies.filter(isAdmitter);
  var sources = [], edges = [];
  if(admitters.length){
    var totals = {rate:0,concurrency:0,cost:0,policy:0}, byKey = {rate:{},concurrency:{},cost:{},policy:{}};
    admitters.forEach(function(p){ var d=dbl(p), t=tdbl(p);
      LANES.forEach(function(l){ totals[l]+=(d[l]||0); (t[l]||[]).forEach(function(h){ byKey[l][h.key]=(byKey[l][h.key]||0)+h.count; }); }); });
    LANES.forEach(function(l){ if(totals[l]>0){ sources.push({id:l,label:l,color:l,total:totals[l]});
      Object.keys(byKey[l]).forEach(function(k){ edges.push({source:l,key:k,value:byKey[l][k],color:l}); }); } });
  } else {
    snap.policies.forEach(function(p,i){ var a=p.analytics||{}; if(!a.denied) return; var color=SERIES[i%SERIES.length];
      sources.push({id:p.name,label:p.name,color:color,total:a.denied});
      (a.topDenied||[]).forEach(function(h){ edges.push({source:p.name,key:h.key,value:h.count,color:color}); }); });
  }
  return { sources:sources, edges:edges };
}
function renderSankey(snap){
  var f = heroFlows(snap);
  var srcs = f.sources.filter(function(s){ return s.total>0; });
  var hasAdm = snap.policies.some(isAdmitter);
  el("heroEmpty").innerHTML = !hasAdm
    ? '<div class="empty">Showing per-policy denials. Configure <code>unifiedAdmission</code> to light up the rate / concurrency / cost axis breakdown.</div>' : "";
  if(!srcs.length){ el("sankey").innerHTML = '<div class="empty">No denials in the current window &mdash; nothing is being throttled.</div>'; return; }
  var keyTot = {}; f.edges.forEach(function(e){ keyTot[e.key]=(keyTot[e.key]||0)+e.value; });
  var keys = Object.keys(keyTot).sort(function(a,b){ return keyTot[b]-keyTot[a]; }).slice(0,8);
  var keep = {}; keys.forEach(function(k){ keep[k]=true; });
  var edges = f.edges.filter(function(e){ return keep[e.key]; });
  var W=720,H=300,padL=78,nodeW=13,gap=8,kx=W-150;
  var srcSum = srcs.reduce(function(s,x){ return s+x.total; },0) || 1;
  var rows = Math.max(srcs.length, keys.length);
  var scale = (H - gap*rows - 12) / srcSum;
  var sy=8, sPos={}, sNodes = srcs.map(function(s){ var h=Math.max(4,s.total*scale), y=sy; sy+=h+gap; sPos[s.id]={y:y,h:h,off:0};
    return '<rect x="'+padL+'" y="'+y+'" width="'+nodeW+'" height="'+h+'" rx="2" class="seg '+s.color+'"></rect>'+
           '<text x="'+(padL-6)+'" y="'+(y+h/2+4)+'" text-anchor="end" class="snode">'+esc(s.label)+' '+s.total+'</text>'; });
  var ky=8, kPos={}, kNodes = keys.map(function(k){ var h=Math.max(4,keyTot[k]*scale), y=ky; ky+=h+gap; kPos[k]={y:y,h:h,off:0};
    return '<rect x="'+kx+'" y="'+y+'" width="'+nodeW+'" height="'+h+'" rx="2" fill="#2a3547"></rect>'+
           '<text x="'+(kx+nodeW+6)+'" y="'+(y+h/2+4)+'" class="knode">'+esc(k)+' '+keyTot[k]+'</text>'; });
  var x0=padL+nodeW, bands = edges.sort(function(a,b){ return b.value-a.value; }).map(function(e){
    var sp=sPos[e.source], kp=kPos[e.key]; if(!sp||!kp) return "";
    var th=Math.max(1,e.value*scale); var sc=sp.y+sp.off+th/2; sp.off+=th; var kc=kp.y+kp.off+th/2; kp.off+=th;
    var mx=(x0+kx)/2; return '<path class="band '+e.color+'" stroke-width="'+th.toFixed(1)+'" d="M'+x0+','+sc.toFixed(1)+' C'+mx+','+sc.toFixed(1)+' '+mx+','+kc.toFixed(1)+' '+kx+','+kc.toFixed(1)+'"></path>'; });
  el("sankey").innerHTML = '<svg class="sankey" viewBox="0 0 '+W+' '+H+'" width="100%" preserveAspectRatio="xMidYMid meet">'+bands.join("")+sNodes.join("")+kNodes.join("")+'</svg>';
}

/* ---- timeline: client-accumulated deny deltas by series ---- */
var history = [], lastCum = null;
function pushHistory(snap){
  var cum = {rate:0,concurrency:0,cost:0,policy:0,limiter:0};
  snap.policies.forEach(function(p){ var a=p.analytics||{};
    if(isAdmitter(p)){ var d=dbl(p); LANES.forEach(function(l){ cum[l]+=(d[l]||0); }); }
    else { cum.limiter += (a.denied||0); } });
  var delta = {rate:0,concurrency:0,cost:0,policy:0,limiter:0};
  if(lastCum){ SERIES.forEach(function(k){ delta[k]=Math.max(0, cum[k]-lastCum[k]); }); }
  lastCum = cum; history.push(delta); if(history.length>60) history.shift(); renderTimeline();
}
function renderTimeline(){
  if(history.length<2){ el("timeline").innerHTML = '<div class="empty" style="height:90px">accumulating&hellip;</div>'; return; }
  var W=720,H=90,n=history.length, stepX=W/(n-1), max=1;
  history.forEach(function(h){ var t=SERIES.reduce(function(s,k){ return s+(h[k]||0); },0); if(t>max) max=t; });
  var base = history.map(function(){ return H; });
  var paths = SERIES.map(function(k){
    var top = history.map(function(h,i){ return base[i] - (h[k]||0)/max*(H-6); });
    var up = top.map(function(y,i){ return (i?"L":"M")+(i*stepX).toFixed(1)+","+y.toFixed(1); }).join(" ");
    var down=""; for(var i=n-1;i>=0;i--){ down += "L"+(i*stepX).toFixed(1)+","+base[i].toFixed(1); }
    for(var j=0;j<n;j++){ base[j]=top[j]; }
    return '<path class="area '+k+'" d="'+up+' '+down+' Z"></path>';
  });
  el("timeline").innerHTML = '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="90" preserveAspectRatio="none">'+paths.join("")+'</svg>';
}

/* ---- panels ---- */
function renderThroughput(snap){
  var allow=0,deny=0; snap.policies.forEach(function(p){ var a=p.analytics||{}; allow+=(a.allowed||0); deny+=(a.denied||0); });
  var tot=allow+deny; el("throughput").innerHTML = tot? ('window total '+tot+' &middot; allowed '+allow+' &middot; denied '+deny+' ('+Math.round(100*deny/tot)+'%)') : 'no traffic yet';
}
function renderGuarantee(snap){
  var rows = snap.policies.filter(function(p){ return p.limit; }).map(function(p){
    var used=(p.analytics&&p.analytics.allowed)||0, lim=p.limit, pct=lim?Math.min(100,100*used/lim):0;
    return '<tr><td><code>'+esc(p.name)+'</code></td><td style="width:42%"><div class="bar"><div class="seg '+(pct>=90?"cost":"concurrency")+'" style="width:'+pct.toFixed(0)+'%"></div></div></td><td>'+used+' / '+lim+'</td></tr>'; }).join("");
  var inv = snap.guards.map(function(g){ var pass=g.inflight<=g.limit; return '<span class="chip '+(pass?"concurrency":"fail")+'">'+esc(g.name)+': &#931;inflight&#8804;L '+(pass?"PASS":"FAIL")+'</span>'; }).join(" ");
  el("guarantee").innerHTML =
    (rows? '<table><thead><tr><th>policy</th><th>admitted this window vs ceiling</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>' : '<div class="empty">No per-policy ceiling observed yet.</div>')+
    '<div style="margin-top:10px">'+(inv||'<span class="muted">no concurrency invariants to check</span>')+'</div>'+
    '<div class="muted" style="margin-top:8px">Headroom to the observed ceiling (per process). The fleet-size-independent overshoot bound <code>Limit + N&#183;(B&#8722;1)</code> is machine-checked in <a href="'+SPEC+'" target="_blank" rel="noopener">spec/DistributedLeasing.tla</a> &mdash; a link to the proof, not a live needle. True fleet overshoot needs the aggregator.</div>';
}
function renderPolicies(snap){
  if(!snap.policies.length){ el("policies").innerHTML = '<div class="empty">No policies tracked yet.</div>'; return; }
  var rows = snap.policies.map(function(p){ var a=p.analytics||{};
    var top=(a.topDenied||[]).slice(0,3).map(function(h){ return esc(h.key)+":"+h.count; }).join(", ");
    var kind = p.kind==="admitter" ? "admitter" : ("limiter"+(p.strategy?(" ("+esc(p.strategy)+")"):""));
    var lat = p.latency ? (p.latency.avgMs.toFixed(3)+" / "+p.latency.maxMs.toFixed(2)+"ms") : "&mdash;";
    return '<tr><td><code>'+esc(p.name)+'</code></td><td class="muted">'+kind+'</td><td>'+(a.allowed||0)+'</td><td>'+(a.denied||0)+'</td><td>'+(a.total?Math.round(100*(a.denyRate||0))+"%":"&mdash;")+'</td><td>'+lat+'</td><td class="muted">'+(top||"&mdash;")+'</td></tr>'; }).join("");
  el("policies").innerHTML = '<table><thead><tr><th>name</th><th>kind</th><th>allowed</th><th>denied</th><th>deny%</th><th>lat avg/max</th><th>top denied keys</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function renderGuards(snap){
  if(!snap.guards.length){ el("guards").innerHTML = '<div class="empty">No concurrency guards tracked.</div>'; return; }
  var rows = snap.guards.map(function(g){
    var fenced = g.fenced ? '<span class="chip fail">FENCED</span>' : '<span class="muted">ok</span>';
    var fleet = (g.nodes!=null) ? (g.share+"/"+g.lGlobal+" &middot; "+g.nodes+" nodes") : '<span class="muted">single</span>';
    return '<tr><td><code>'+esc(g.name)+'</code></td><td>'+g.inflight+' / '+g.limit+'</td><td>'+Math.round(g.rttNoload)+'ms</td><td>'+fleet+'</td><td>'+fenced+'</td></tr>'; }).join("");
  el("guards").innerHTML = '<table><thead><tr><th>guard</th><th>inflight/limit</th><th>noload rtt</th><th>fleet</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
  var fences = (snap.recentFences||[]).slice(-6).reverse();
  el("fences").innerHTML = fences.length ? ('<span class="muted">self-fence events: </span>'+fences.map(function(r){ return '<span class="chip fail">'+esc(r.guard)+' '+new Date(r.at).toLocaleTimeString()+'</span>'; }).join(" ")) : "";
}
function renderStats(snap){
  if(!snap.stats.length){ el("stats").innerHTML = '<div class="empty">No fairness / custom stats sources.</div>'; return; }
  el("stats").innerHTML = snap.stats.map(function(s){ var v=s.value||{};
    if(v && v.tenants && v.tenants.length){
      var trs=v.tenants.map(function(t){ var g=(t.guaranteed!=null)?t.guaranteed:(t.guaranteed_share!=null?t.guaranteed_share:"-");
        return '<tr><td><code>'+esc(t.tenant)+'</code></td><td>'+(t.weight!=null?t.weight:"-")+'</td><td>'+(t.used!=null?t.used:"-")+'</td><td>'+g+'</td></tr>'; }).join("");
      return '<div style="margin-bottom:8px"><b>'+esc(s.name)+'</b> <span class="muted">'+esc(s.kind)+'</span><table><thead><tr><th>tenant</th><th>weight</th><th>used</th><th>guaranteed</th></tr></thead><tbody>'+trs+'</tbody></table></div>'; }
    return '<div><b>'+esc(s.name)+'</b> <span class="muted">'+esc(s.kind)+'</span> <code>'+esc(JSON.stringify(v).slice(0,180))+'</code></div>'; }).join("");
}
function renderHealth(snap){
  var h=snap.health; if(!h){ el("healthPanel").style.display="none"; return; } el("healthPanel").style.display="block";
  var parts=[]; if(h.backend) parts.push("backend <code>"+esc(h.backend)+"</code>"); if(h.reachable!=null) parts.push(h.reachable?"reachable":"<span class='chip fail'>unreachable</span>");
  if(h.failMode) parts.push("fail="+esc(h.failMode)); if(h.leaseTableSize!=null) parts.push("leases "+h.leaseTableSize); if(h.reclaimCount!=null) parts.push("reclaimed "+h.reclaimCount);
  el("health").innerHTML = parts.join(" &middot; ");
}

/* ---- live denial feed + drawer ---- */
var feed = [];
function pushDenial(row){ feed.unshift(row); if(feed.length>60) feed.pop(); renderFeed(); }
function renderFeed(){
  if(!feed.length){ el("feed").innerHTML = '<div class="empty">Waiting for denials&hellip;</div>'; return; }
  el("feed").innerHTML = feed.map(function(r,i){
    var lane = r.lane ? '<span class="chip '+r.lane+'">'+r.lane+'</span>' : '<span class="muted">policy</span>';
    return '<div class="row" data-i="'+i+'"><span class="muted">'+new Date(r.at).toLocaleTimeString()+'</span> '+lane+' <code>'+esc(r.policy)+'</code> <span class="muted">key</span> <code>'+esc(r.key||"(global)")+'</code></div>'; }).join("");
}
function openDrawer(r){
  if(!r) return; var d=r.decision||{}, pa=r.perAxis||{};
  var axisRows = Object.keys(pa).map(function(ax){ var x=pa[ax]; return '<tr><td><span class="chip '+ax+'">'+ax+'</span></td><td>'+x.remaining+'</td><td>'+x.limit+'</td><td>'+x.retryAfterMs+'ms</td></tr>'; }).join("");
  var body = axisRows || ('<tr><td>combined</td><td>'+(d.remaining!=null?d.remaining:"-")+'</td><td>'+(d.limit!=null?d.limit:"-")+'</td><td>'+(d.retryAfterMs||0)+'ms</td></tr>');
  el("drawer").innerHTML = '<span class="close" onclick="document.getElementById(\\'drawer\\').style.display=\\'none\\'">&times;</span>'+
    '<div class="drawer-h">Why denied: <code>'+esc(r.policy)+'</code> &middot; key <code>'+esc(r.key||"(global)")+'</code> '+(r.lane?'<span class="chip '+r.lane+'">'+r.lane+'</span>':"")+'</div>'+
    '<table><thead><tr><th>axis</th><th>remaining</th><th>limit</th><th>retry</th></tr></thead><tbody>'+body+'</tbody></table>'+
    '<div class="muted" style="margin-top:6px">resetAt '+(d.resetAt?new Date(d.resetAt).toLocaleTimeString():"-")+'</div>';
  el("drawer").style.display="block";
}

/* ---- wiring ---- */
function renderAll(snap){
  var m=snap.meta||{}; el("meta").textContent = (m.mode||"process")+" \\u00b7 window "+Math.round((m.windowMs||0)/1000)+"s"+(m.nodeId?(" \\u00b7 "+m.nodeId):"")+(m.fleetNodes?(" \\u00b7 "+m.fleetNodes+" nodes"):"");
  renderSankey(snap); renderThroughput(snap); renderGuarantee(snap); renderPolicies(snap); renderGuards(snap); renderStats(snap); renderHealth(snap); pushHistory(snap);
  if(snap.recentDenials && !feed.length){ feed = snap.recentDenials.slice().reverse().slice(0,60); renderFeed(); }
}
function setConn(live){ el("conn").className = "dot"+(live?" live":""); }
function init(){
  el("feed").addEventListener("click", function(ev){ var t=ev.target; while(t && t!==this && !t.getAttribute("data-i")) t=t.parentNode; if(t && t.getAttribute){ var i=t.getAttribute("data-i"); if(i!=null) openDrawer(feed[+i]); } });
  if(window.EventSource) connect(); else poll();
}
function connect(){
  try {
    var es = new EventSource(BASE+"/api/stream");
    es.addEventListener("snapshot", function(e){ setConn(true); renderAll(JSON.parse(e.data)); });
    es.addEventListener("denial", function(e){ pushDenial(JSON.parse(e.data)); });
    es.addEventListener("fence", function(){ /* reflected in the next snapshot */ });
    es.onerror = function(){ setConn(false); };
  } catch(_) { poll(); }
}
function poll(){
  var go = function(){ fetch(BASE+"/api/snapshot").then(function(r){ return r.json(); }).then(function(s){ setConn(true); renderAll(s); }).catch(function(){ setConn(false); }); };
  go(); setInterval(go, 2000);
}
init();
</script>
</body>
</html>`;
