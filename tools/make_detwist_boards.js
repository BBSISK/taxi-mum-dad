#!/usr/bin/env node
/* Builds the daily DeTwist boards that detwist/boards.json holds.
 *
 *   node tools/make_detwist_boards.js 2026-11-09 365 > detwist/boards.json
 *   node tools/make_detwist_boards.js <first day> <how many days> [--merge existing.json]
 *
 * The rules, solver and generator below are the same code the prototype ran in the browser
 * (static/detwist.js keeps its own copy of the rules and solver for the Hint button, and
 * detwist/rules.py re-checks every finished game on the server). Each board is drawn at random
 * from the date, then hill-climbed for as many fewest-moves as the solver can find.
 * One board takes a few seconds. Keep LADDER in step with the difficulty described in the README.
 */
'use strict';
const fs = require('fs');

const LADDER = [  // Monday to Sunday
  { name: 'Easy', n: 5, k: 3, step: 3, layers: false, iters: 60 },
  { name: 'Medium', n: 6, k: 2, step: 3, layers: false, iters: 60 },
  { name: 'Hard', n: 7, k: 2, step: 3, layers: false, iters: 60 },
  { name: 'Hard', n: 6, k: 2, step: 2, layers: true, iters: 120 },
  { name: 'Expert', n: 7, k: 2, step: 2, layers: true, iters: 120 },
  { name: 'Expert', n: 8, k: 2, step: 2, layers: true, iters: 120 },
  { name: 'Fiendish', n: 9, k: 2, step: 2, layers: true, iters: 100 },
];

var STEP = 0; // 0 means an end may jump to any empty pin; otherwise at most STEP pins round the rim
  /* ---------- Seeded random ---------- */
  function hashStr(s){var h=1779033703^s.length;for(var i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),3432918353);h=h<<13|h>>>19}
    h=Math.imul(h^h>>>16,2246822507);h=Math.imul(h^h>>>13,3266489909);return (h^h>>>16)>>>0}
  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

  /* ---------- Chord logic (pins sit on a circle) ----------
     rel[i][j] is true when band i lies over band j. It is fixed for the whole puzzle,
     so wherever two bands cross, the same one is on top. rel is null on flat days. */
  function between(x,a,b){var lo=Math.min(a,b),hi=Math.max(a,b);return x>lo&&x<hi}
  function cross(p,q){return between(q.a,p.a,p.b)!==between(q.b,p.a,p.b)}
  function counts(bands){
    var c=bands.map(function(){return 0});
    for(var i=0;i<bands.length;i++)for(var j=i+1;j<bands.length;j++)if(cross(bands[i],bands[j])){c[i]++;c[j]++}
    return c;
  }
  function tally(bands,rel){
    var m=bands.length,cr=[],ov=[],un=[],i,j;
    for(i=0;i<m;i++){cr.push(0);ov.push(0);un.push(0)}
    for(i=0;i<m;i++)for(j=i+1;j<m;j++)if(cross(bands[i],bands[j])){
      cr[i]++;cr[j]++;
      if(rel){if(rel[bands[i].id][bands[j].id]){ov[i]++;un[j]++}else{ov[j]++;un[i]++}}
    }
    return {cr:cr,ov:ov,un:un};
  }
  function freeFlags(bands,rel){
    var t=tally(bands,rel);
    return bands.map(function(_,i){return t.cr[i]===0||!!(rel&&t.ov[i]===t.cr[i])});
  }
  function cascade(bands,rel){
    var cur=bands;
    for(;;){
      var f=freeFlags(cur,rel);
      if(!f.some(Boolean))return cur;
      cur=cur.filter(function(_,i){return !f[i]});
      if(!cur.length)return cur;
    }
  }
  function circ(a,b,P){var d=Math.abs(a-b);return Math.min(d,P-d)}
  function crossTotal(bands){var t=0;counts(bands).forEach(function(x){t+=x});return t/2}
  function weave(bands,rel){var t=tally(bands,rel),s=0;for(var i=0;i<bands.length;i++)s+=Math.min(t.ov[i],t.un[i]);return s}

  /* ---------- Solver: beam search for the fewest moves ---------- */
  function solve(bands,P,rel,maxDepth,width){
    maxDepth=maxDepth||16;width=width||250;
    var start=cascade(bands,rel);
    if(!start.length)return [];
    var level=[{bands:start,path:[]}];
    for(var depth=1;depth<=maxDepth;depth++){
      var next=new Map();
      for(var s=0;s<level.length;s++){
        var st=level[s],occ={};
        st.bands.forEach(function(b){occ[b.a]=1;occ[b.b]=1});
        var empties=[];for(var p=0;p<P;p++)if(!occ[p])empties.push(p);
        for(var bi=0;bi<st.bands.length;bi++){
          for(var e=0;e<2;e++){
            var end=e?'b':'a';
            for(var q=0;q<empties.length;q++){
              var to=empties[q];
              if(STEP&&circ(to,st.bands[bi][end],P)>STEP)continue;
              var nb=st.bands.map(function(b,i){return i===bi?{id:b.id,a:end==='a'?to:b.a,b:end==='b'?to:b.b}:b});
              var alive=cascade(nb,rel);
              var move={id:st.bands[bi].id,end:end,to:to};
              if(!alive.length)return st.path.concat([move]);
              var key=alive.map(function(b){return (rel?b.id+':':'')+Math.min(b.a,b.b)+'-'+Math.max(b.a,b.b)}).sort().join('|');
              if(!next.has(key))next.set(key,{bands:alive,path:st.path.concat([move]),score:alive.length*100+(rel?weave(alive,rel):crossTotal(alive))});
            }
          }
        }
      }
      level=Array.from(next.values()).sort(function(x,y){return x.score-y.score}).slice(0,width);
      if(!level.length)return null;
    }
    return null;
  }

  // Smallest number of moves after which some band pops free (the setup depth). Higher means fewer lucky shortcuts.
  function firstFreeDepth(bands,P,rel,maxD){
    var level=[bands],seen=new Set();
    for(var d=1;d<=maxD;d++){
      var next=[];
      for(var s=0;s<level.length;s++){
        var st=level[s],occ={};
        st.forEach(function(b){occ[b.a]=1;occ[b.b]=1});
        var empties=[];for(var p=0;p<P;p++)if(!occ[p])empties.push(p);
        for(var bi=0;bi<st.length;bi++)for(var e=0;e<2;e++){
          var end=e?'b':'a';
          for(var q=0;q<empties.length;q++){
            var to=empties[q];
            if(STEP&&circ(to,st[bi][end],P)>STEP)continue;
            var nb=st.map(function(b,i){return i===bi?{id:b.id,a:end==='a'?to:b.a,b:end==='b'?to:b.b}:b});
            if(cascade(nb,rel).length<st.length)return d;
            var key=nb.map(function(b){return b.id+':'+b.a+'-'+b.b}).join('|');
            if(!seen.has(key)){seen.add(key);next.push(nb)}
          }
        }
      }
      level=next;
    }
    return maxD+1;
  }

  /* ---------- Daily puzzle generator ----------
     Draw a valid random board, then hill-climb: swap two pins or flip one over/under pair,
     and keep the change whenever the solver's fewest-moves count does not drop. */
  function validBoard(bands,rel,cfg){
    var c=counts(bands);
    if(Math.min.apply(null,c)<(cfg.layers?2:1))return false;
    if(c.reduce(function(x,y){return x+y},0)/2<cfg.n*(cfg.layers?1.6:1.2))return false;
    if(rel&&cascade(bands,rel).length!==bands.length)return false;
    return true;
  }
  function randomRel(n,rnd){
    var rel=[],x,y;
    for(x=0;x<n;x++){rel.push([]);for(y=0;y<n;y++)rel[x].push(false)}
    for(x=0;x<n;x++)for(y=x+1;y<n;y++){var o=rnd()<.5;rel[x][y]=o;rel[y][x]=!o}
    return rel;
  }
  function makePuzzle(dateKey,cfg){
    var rnd=mulberry32(hashStr('detwist-'+dateKey));
    STEP=cfg.step||0;
    var P=2*cfg.n+cfg.k,cur=null;
    for(var tries=0;tries<2000&&!cur;tries++){
      var pins=[];for(var i=0;i<P;i++)pins.push(i);
      for(var j=P-1;j>0;j--){var r=Math.floor(rnd()*(j+1));var t=pins[j];pins[j]=pins[r];pins[r]=t}
      var bands=[];for(var b=0;b<cfg.n;b++)bands.push({id:b,a:pins[2*b],b:pins[2*b+1]});
      var rel=cfg.layers?randomRel(cfg.n,rnd):null;
      if(!validBoard(bands,rel,cfg))continue;
      var sol=solve(bands,P,rel,24,150);
      if(sol)cur={P:P,n:cfg.n,bands:bands,rel:rel,par:sol.length,step:STEP};
    }
    if(!cur)return null;
    for(var it=0;it<(cfg.iters||0);it++){
      var nb=cur.bands.map(function(b){return {id:b.id,a:b.a,b:b.b}});
      var nr=cur.rel?cur.rel.map(function(row){return row.slice()}):null;
      if(nr&&rnd()<.4){
        var x=Math.floor(rnd()*cfg.n),y=Math.floor(rnd()*cfg.n);
        if(x===y)continue;
        nr[x][y]=!nr[x][y];nr[y][x]=!nr[y][x];
      }else{
        var p=Math.floor(rnd()*P),q=Math.floor(rnd()*P);
        if(p===q)continue;
        nb.forEach(function(bd){
          if(bd.a===p)bd.a=q;else if(bd.a===q)bd.a=p;
          if(bd.b===p)bd.b=q;else if(bd.b===q)bd.b=p;
        });
      }
      if(!validBoard(nb,nr,cfg))continue;
      var s2=solve(nb,P,nr,24,150);
      if(s2&&s2.length>=cur.par)cur={P:P,n:cfg.n,bands:nb,rel:nr,par:s2.length,step:STEP};
    }
    return cur;
  }


function isoDay(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }

function main() {
  const args = process.argv.slice(2);
  const mergeAt = args.indexOf('--merge');
  const existing = mergeAt >= 0 ? JSON.parse(fs.readFileSync(args[mergeAt + 1], 'utf8')) : {};
  const [first, count] = [args[0], parseInt(args[1], 10)];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first || '') || !(count > 0)) { console.error('usage: make_detwist_boards.js YYYY-MM-DD DAYS [--merge boards.json]'); process.exit(1); }
  const out = { ...existing };
  const start = Date.parse(first + 'T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * 864e5), key = isoDay(d), cfg = LADDER[(d.getUTCDay() + 6) % 7];
    if (out[key]) continue;
    const t = Date.now(), pz = makePuzzle(key, cfg);
    if (!pz) { console.error('no board for ' + key); process.exit(2); }
    let rel = null;
    if (pz.rel) { rel = ''; for (let x = 0; x < pz.n; x++) for (let y = x + 1; y < pz.n; y++) rel += pz.rel[x][y] ? '1' : '0'; }
    out[key] = { n: pz.n, P: pz.P, step: pz.step, par: pz.par, name: cfg.name, pins: pz.bands.map(b => [b.a, b.b]), rel };
    console.error(key + ' ' + cfg.name + ' par ' + pz.par + ' (' + (Date.now() - t) + ' ms)');
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
  process.stdout.write(JSON.stringify(sorted));
}
main();
