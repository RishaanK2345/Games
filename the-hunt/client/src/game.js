// Level 0: Hunt, browser client
import * as THREE_NS from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { LuminosityHighPassShader } from 'three/examples/jsm/shaders/LuminosityHighPassShader.js';
import { CONFIG, BASE_CONFIG, ROUND_TIME, resetConfig } from '../../shared/config.js';
import { hashSeed, makeRng, clamp, dist2 } from '../../shared/rng.js';
import { generateMap, neighbors, bfs, pathFrom } from '../../shared/mapgen.js';
import { MAP, BOXES, setWorld, buildColliders, cellOf, nearby, pointBlocked, collide, los } from '../../shared/physics.js';
import { ANOMALIES, pickAnomaly } from '../../shared/anomalies.js';
import { createRound, step, bindRound, pickEntity, agentById, ENTITY_ID, fmt, angDiff, turnToward, speedOf, isWet, noiseRadius, isDark, blackoutAt, canSee, entitySpeed, usableVent } from '../../shared/sim.js';
import * as SIM from '../../shared/sim.js';
import { BOT_NAMES, botNames as rosterBotNames, cleanName, GAME_VERSION } from '../../shared/roster.js';
import { SERVER_URL, joinRoom } from './net.js';
import './style.css';

// three r128 addons live on one namespace, like the old <script> build
const THREE={...THREE_NS, EffectComposer, RenderPass, ShaderPass, UnrealBloomPass, CopyShader, LuminosityHighPassShader};

/* =====================================================================
   CONFIG  (shared/config.ts in the real project)
   ===================================================================== */


/* =====================================================================
   SEEDED RNG  (shared/rng.ts)
   ===================================================================== */

function randomSeed(){ return String(100000+Math.floor(Math.random()*900000)); }   // 6-digit room number

/* =====================================================================
   MAP GENERATOR  (shared/mapgen.ts)
   Thin-wall grid maze -> braid dead ends -> extra loops -> open rooms
   h[y][x] = wall on the top edge of cell (x,y), y in 0..N
   v[y][x] = wall on the left edge of cell (x,y), x in 0..N
   ===================================================================== */


/* =====================================================================
   COLLISION + LINE OF SIGHT  (shared/physics.ts)
   ===================================================================== */


/* =====================================================================
   PROCEDURAL PBR TEXTURES  (color + normal maps, no external assets)
   ===================================================================== */
const srgb=h=>new THREE.Color(h).convertSRGBToLinear();
function mkCanvas(w,h){ const c=document.createElement('canvas'); c.width=w; c.height=h; return c; }
function toTex(c,color,rep){ const t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; if(color) t.encoding=THREE.sRGBEncoding; t.anisotropy=8; if(rep) t.repeat.set(rep[0],rep[1]); return t; }
function normalFromHeight(hc,strength){
  const w=hc.width,h=hc.height, src=hc.getContext('2d').getImageData(0,0,w,h).data, out=mkCanvas(w,h), og=out.getContext('2d'), id=og.createImageData(w,h), d=id.data;
  const H=(x,y)=>src[(((y+h)%h)*w+((x+w)%w))*4];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const dx=(H(x+1,y)-H(x-1,y))/255*strength, dy=(H(x,y+1)-H(x,y-1))/255*strength, l=Math.sqrt(dx*dx+dy*dy+1), i=(y*w+x)*4;
    d[i]=(-dx/l*0.5+0.5)*255; d[i+1]=(dy/l*0.5+0.5)*255; d[i+2]=(1/l*0.5+0.5)*255; d[i+3]=255; }
  og.putImageData(id,0,0); return out;
}
function noise(g,w,h,amt,mono=true){ const id=g.getImageData(0,0,w,h), d=id.data; for(let i=0;i<d.length;i+=4){ const n=(Math.random()-0.5)*amt; d[i]+=n; d[i+1]+=mono?n:(Math.random()-0.5)*amt; d[i+2]+=mono?n*0.85:(Math.random()-0.5)*amt; } g.putImageData(id,0,0); }
function blob(g,x,y,r,col,a){ const gr=g.createRadialGradient(x,y,0,x,y,r); gr.addColorStop(0,col.replace('A',a)); gr.addColorStop(1,col.replace('A',0)); g.fillStyle=gr; g.fillRect(x-r,y-r,r*2,r*2); }

function makeWallTex(variant){
  const W=1024,H=768, c=mkCanvas(W,H), g=c.getContext('2d'), hc=mkCanvas(W,H), hg=hc.getContext('2d');
  g.fillStyle='#c3ad5a'; g.fillRect(0,0,W,H); hg.fillStyle='#808080'; hg.fillRect(0,0,W,H);
  for(let i=0;i<40;i++) blob(g,Math.random()*W,Math.random()*H,60+Math.random()*160,Math.random()<0.5?'rgba(150,128,50,A)':'rgba(215,196,110,A)',0.12);
  // printed pattern: thin double stripes + small chevrons
  for(let x=0;x<W;x+=58){
    g.fillStyle='rgba(130,108,40,.22)'; g.fillRect(x,0,2,H); g.fillRect(x+6,0,1,H); hg.fillStyle='rgba(160,160,160,.6)'; hg.fillRect(x,0,2,H);
    g.strokeStyle='rgba(125,102,38,.16)'; g.lineWidth=1.4; for(let y=12;y<H;y+=29){ g.beginPath(); g.moveTo(x+22,y+5); g.lineTo(x+29,y); g.lineTo(x+36,y+5); g.stroke(); }
  }
  noise(g,W,H,14); noise(hg,W,H,40);
  // wallpaper strip seams, some peeling
  for(let x=180+Math.random()*60;x<W;x+=210+Math.random()*30){
    g.fillStyle='rgba(90,72,25,.35)'; g.fillRect(x,0,1.5,H); hg.fillStyle='#4a4a4a'; hg.fillRect(x,0,2,H);
    if(Math.random()<0.45){ const py=Math.random()<0.6?0:H*0.45+Math.random()*H*0.2, ph=60+Math.random()*120, pw=10+Math.random()*25;
      g.fillStyle='rgba(40,30,10,.35)'; g.beginPath(); g.moveTo(x+pw,py); g.lineTo(x+pw+5,py+4); g.lineTo(x+3,py+ph+4); g.lineTo(x,py+ph); g.fill();
      g.fillStyle='#d9cfa6'; g.beginPath(); g.moveTo(x,py); g.lineTo(x+pw,py); g.lineTo(x,py+ph); g.fill();
      hg.fillStyle='#d0d0d0'; hg.beginPath(); hg.moveTo(x,py); hg.lineTo(x+pw,py); hg.lineTo(x,py+ph); hg.fill(); }
  }
  // water damage rising from the floor, with darker tide lines
  const stains=1+variant*2+Math.floor(Math.random()*2);
  for(let i=0;i<stains;i++){
    const sx=Math.random()*W, top=H-120-Math.random()*260, sw=70+Math.random()*190;
    const pts=[]; for(let k=0;k<=10;k++){ const xx=sx-sw/2+sw*k/10, yy=top+Math.sin(k*1.3+i*2.1)*14+Math.random()*8+((k-5)/5)**2*110; pts.push([xx,Math.min(H-26,yy)]); }
    const path=()=>{ g.beginPath(); g.moveTo(sx-sw/2,H-26); g.lineTo(pts[0][0],pts[0][1]); for(let k=1;k<pts.length-1;k++){ const mx=(pts[k][0]+pts[k+1][0])/2, my=(pts[k][1]+pts[k+1][1])/2; g.quadraticCurveTo(pts[k][0],pts[k][1],mx,my); } g.lineTo(sx+sw/2,H-26); g.closePath(); };
    g.save(); g.filter='blur(6px)'; path(); g.fillStyle='rgba(120,92,30,.22)'; g.fill();
    g.filter='blur(1.2px)'; g.strokeStyle='rgba(95,68,20,.32)'; g.lineWidth=2; g.stroke(); g.translate(0,14); g.strokeStyle='rgba(95,68,20,.14)'; g.stroke(); g.restore();
    hg.fillStyle='rgba(170,170,170,.3)'; for(let k=0;k<50;k++) hg.fillRect(sx-sw/2+Math.random()*sw,top+40+Math.random()*(H-top-40),2+Math.random()*4,2+Math.random()*4);
  }
  // drips from the ceiling
  for(let i=0;i<variant+1;i++){ const x=Math.random()*W, len=40+Math.random()*220, gr=g.createLinearGradient(0,0,0,len); gr.addColorStop(0,'rgba(110,85,30,.35)'); gr.addColorStop(1,'rgba(110,85,30,0)'); g.fillStyle=gr; g.fillRect(x,0,3+Math.random()*5,len); }
  // mold specks near the floor
  for(let i=0;i<variant*130;i++){ const x=Math.random()*W, y=H-30-Math.random()*Math.random()*220; g.fillStyle=`rgba(${30+Math.random()*30},${35+Math.random()*25},15,${0.3+Math.random()*0.5})`; g.beginPath(); g.arc(x,y,0.6+Math.random()*2.2,0,6.3); g.fill(); }
  // grime near ceiling and floor
  let gr=g.createLinearGradient(0,0,0,60); gr.addColorStop(0,'rgba(40,30,10,.35)'); gr.addColorStop(1,'rgba(40,30,10,0)'); g.fillStyle=gr; g.fillRect(0,0,W,60);
  gr=g.createLinearGradient(0,H-100,0,H-26); gr.addColorStop(0,'rgba(40,30,10,0)'); gr.addColorStop(1,'rgba(40,30,10,.42)'); g.fillStyle=gr; g.fillRect(0,H-100,W,74);
  // painted baseboard
  g.fillStyle='#cdbf96'; g.fillRect(0,H-26,W,26); g.fillStyle='rgba(60,45,15,.55)'; g.fillRect(0,H-27,W,2); g.fillStyle='rgba(255,250,220,.25)'; g.fillRect(0,H-24,W,2); g.fillStyle='rgba(40,30,10,.4)'; g.fillRect(0,H-6,W,6);
  for(let i=0;i<30;i++) blob(g,Math.random()*W,H-12,6+Math.random()*14,'rgba(70,55,20,A)',0.3);
  hg.fillStyle='#d4d4d4'; hg.fillRect(0,H-25,W,25); hg.fillStyle='#5a5a5a'; hg.fillRect(0,H-27,W,2);
  return {map:toTex(c,true), normal:toTex(normalFromHeight(hc,2.5),false)};
}
function makeCarpetTex(){
  const S=512, c=mkCanvas(S,S), g=c.getContext('2d'), hc=mkCanvas(S,S), hg=hc.getContext('2d');
  g.fillStyle='#857240'; g.fillRect(0,0,S,S); hg.fillStyle='#808080'; hg.fillRect(0,0,S,S);
  for(let i=0;i<30;i++){ const x=Math.random()*S,y=Math.random()*S,r=20+Math.random()*80, col=Math.random()<0.6?'rgba(70,56,25,A)':'rgba(160,140,80,A)'; for(const [ox,oy] of [[0,0],[S,0],[-S,0],[0,S],[0,-S]]) blob(g,x+ox,y+oy,r,col,0.16); }
  for(let i=0;i<26000;i++){ const x=Math.random()*S,y=Math.random()*S, dark=Math.random()<0.5;
    g.fillStyle=dark?`rgba(55,44,18,${0.3*Math.random()})`:`rgba(190,170,110,${0.2*Math.random()})`; g.fillRect(x,y,1.3,1.3);
    hg.fillStyle=dark?'rgba(30,30,30,.35)':'rgba(225,225,225,.35)'; hg.fillRect(x,y,1.5,1.5); }
  noise(g,S,S,24); noise(hg,S,S,70);
  return {map:toTex(c,true), normal:toTex(normalFromHeight(hc,3.5),false)};
}
function makeCeilTex(){
  const S=512, T=256, bar=7, c=mkCanvas(S,S), g=c.getContext('2d'), hc=mkCanvas(S,S), hg=hc.getContext('2d');
  for(let ty=0;ty<2;ty++) for(let tx=0;tx<2;tx++){
    const x0=tx*T, y0=ty*T, tint=198+Math.random()*16;
    g.fillStyle=`rgb(${tint+12},${tint+6},${tint-24})`; g.fillRect(x0,y0,T,T); hg.fillStyle='#707070'; hg.fillRect(x0,y0,T,T);
    for(let i=0;i<900;i++){ const x=x0+Math.random()*T, y=y0+Math.random()*T, l=2+Math.random()*7, a=Math.random()*6.3;
      g.strokeStyle=`rgba(95,88,65,${0.2+Math.random()*0.35})`; g.lineWidth=0.8+Math.random(); g.beginPath(); g.moveTo(x,y); g.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l); g.stroke();
      hg.strokeStyle='rgba(20,20,20,.7)'; hg.lineWidth=1.2; hg.beginPath(); hg.moveTo(x,y); hg.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l); hg.stroke(); }
    blob(g,x0+T/2,y0+T/2,T*0.7,'rgba(120,110,80,A)',0.1);
  }
  noise(g,S,S,10);
  for(const k of [0,T]){
    g.fillStyle='#bab4a2'; g.fillRect(k,0,bar,S); g.fillRect(0,k,S,bar);
    g.fillStyle='rgba(255,255,240,.35)'; g.fillRect(k,0,2,S); g.fillRect(0,k,S,2); g.fillStyle='rgba(40,35,20,.4)'; g.fillRect(k+bar-1,0,1,S); g.fillRect(0,k+bar-1,S,1);
    hg.fillStyle='#e6e6e6'; hg.fillRect(k,0,bar,S); hg.fillRect(0,k,S,bar);
  }
  return {map:toTex(c,true), normal:toTex(normalFromHeight(hc,2),false)};
}
function makeSuitTex(){
  const S=512, c=mkCanvas(S,S), g=c.getContext('2d'), hc=mkCanvas(S,S), hg=hc.getContext('2d');
  g.fillStyle='#d4a91c'; g.fillRect(0,0,S,S); hg.fillStyle='#808080'; hg.fillRect(0,0,S,S);
  for(let i=0;i<150;i++){   // folds and creases
    const x=Math.random()*S, y=Math.random()*S, l=30+Math.random()*120, a=(Math.random()-0.5)*0.9+(Math.random()<0.5?0:Math.PI/2);
    const cx=x+Math.cos(a)*l*0.5+(Math.random()-0.5)*30, cy=y+Math.sin(a)*l*0.5+(Math.random()-0.5)*30, ex=x+Math.cos(a)*l, ey=y+Math.sin(a)*l, w=2+Math.random()*7;
    g.strokeStyle='rgba(120,85,10,.28)'; g.lineWidth=w; g.beginPath(); g.moveTo(x,y); g.quadraticCurveTo(cx,cy,ex,ey); g.stroke();
    g.strokeStyle='rgba(255,230,140,.16)'; g.lineWidth=w*0.5; g.beginPath(); g.moveTo(x+w*0.6,y-w*0.6); g.quadraticCurveTo(cx+w*0.6,cy-w*0.6,ex+w*0.6,ey-w*0.6); g.stroke();
    hg.strokeStyle='rgba(210,210,210,.5)'; hg.lineWidth=w; hg.beginPath(); hg.moveTo(x,y); hg.quadraticCurveTo(cx,cy,ex,ey); hg.stroke();
  }
  for(let i=0;i<32;i++) blob(g,Math.random()*S,Math.random()*S,10+Math.random()*50,'rgba(70,55,25,A)',0.25);
  for(const y of [S*0.25,S*0.75]){ g.fillStyle='rgba(110,80,10,.6)'; g.fillRect(0,y,S,3); hg.fillStyle='#505050'; hg.fillRect(0,y,S,3); for(let x=0;x<S;x+=8){ g.fillStyle='rgba(60,45,10,.5)'; g.fillRect(x,y+5,4,1.5); } }
  noise(g,S,S,16); noise(hg,S,S,30);
  return {map:toTex(c,true), normal:toTex(normalFromHeight(hc,3),false)};
}
function makeSkinTex(){
  const S=512, c=mkCanvas(S,S), g=c.getContext('2d'), hc=mkCanvas(S,S), hg=hc.getContext('2d');
  g.fillStyle='#211b18'; g.fillRect(0,0,S,S); hg.fillStyle='#808080'; hg.fillRect(0,0,S,S);
  const tones=['rgba(8,6,5,A)','rgba(48,40,35,A)','rgba(50,24,32,A)','rgba(58,50,40,A)'];
  for(let i=0;i<80;i++) blob(g,Math.random()*S,Math.random()*S,15+Math.random()*70,tones[i%4],0.35);
  for(let v=0;v<28;v++){   // veins
    let x=Math.random()*S, y=Math.random()*S, a=Math.random()*6.3; const w=0.8+Math.random()*2.4;
    g.strokeStyle=`rgba(${50+Math.random()*30},12,${28+Math.random()*20},.55)`; g.lineWidth=w; hg.strokeStyle='rgba(240,240,240,.6)'; hg.lineWidth=w+1;
    g.beginPath(); hg.beginPath(); g.moveTo(x,y); hg.moveTo(x,y);
    for(let k=0;k<40;k++){ a+=(Math.random()-0.5)*0.7; x+=Math.cos(a)*5; y+=Math.sin(a)*5; g.lineTo(x,y); hg.lineTo(x,y); }
    g.stroke(); hg.stroke();
  }
  for(let i=0;i<5000;i++){ const x=Math.random()*S,y=Math.random()*S; g.fillStyle='rgba(15,10,8,.35)'; g.fillRect(x,y,1.2,1.2); hg.fillStyle='rgba(30,30,30,.5)'; hg.fillRect(x,y,1.2,1.2); }
  for(let i=0;i<16;i++){ const x=Math.random()*S,y=Math.random()*S,r=3+Math.random()*10; blob(g,x,y,r*1.8,'rgba(95,30,25,A)',0.6); blob(g,x,y,r*0.6,'rgba(150,120,70,A)',0.5); blob(hg,x,y,r,'rgba(20,20,20,A)',0.8); }
  noise(g,S,S,14,false); noise(hg,S,S,50);
  return {map:toTex(c,true), normal:toTex(normalFromHeight(hc,4),false)};
}
let TEX=null;
function makeTextures(){ return {walls:[0,1,2].map(makeWallTex), carpet:makeCarpetTex(), ceil:makeCeilTex(), suit:makeSuitTex(), skin:makeSkinTex()}; }

/* =====================================================================
   AUDIO (Web Audio, all synthesized)
   ===================================================================== */
const SFX={
  ctx:null,
  init(){
    if(this.ctx){ if(this.ctx.state==='suspended') this.ctx.resume(); return; }
    try{ this.ctx=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ this.ctx=null; return; }
    const c=this.ctx; this.master=c.createGain(); this.master.gain.value=PREF.vol; this.master.connect(c.destination);
    const lp=c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=520;
    this.hum=c.createGain(); this.hum.gain.value=0.03; lp.connect(this.hum); this.hum.connect(this.master);
    [[60,'sawtooth',.6],[120,'sine',.35],[180.7,'sine',.15]].forEach(([f,t,g])=>{ const o=c.createOscillator(); o.type=t; o.frequency.value=f; const gg=c.createGain(); gg.gain.value=g; o.connect(gg); gg.connect(lp); o.start(); });
    const len=c.sampleRate; const buf=c.createBuffer(1,len,c.sampleRate), d=buf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1; this.noise=buf;
  },
  ok(){ return this.ctx&&this.ctx.state==='running'; },
  env(g,t,a,peak,dec){ g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(peak,t+a); g.gain.exponentialRampToValueAtTime(0.0001,t+a+dec); },
  thump(vol,when=0){
    if(!this.ok()) return; const c=this.ctx, t=c.currentTime+when, o=c.createOscillator(), g=c.createGain();
    o.type='sine'; o.frequency.setValueAtTime(70,t); o.frequency.exponentialRampToValueAtTime(38,t+0.15);
    this.env(g,t,0.01,vol,0.18); o.connect(g); g.connect(this.master); o.start(t); o.stop(t+0.3);
  },
  squelch(x,z,vol,muffled){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.01,vol*(muffled?0.6:1),0.22); this._out(g,x,z);
    const n=c.createBufferSource(); n.buffer=this.noise; n.playbackRate.value=0.35+Math.random()*0.15; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=1.5; bp.frequency.setValueAtTime(muffled?250:700,t); bp.frequency.exponentialRampToValueAtTime(muffled?150:300,t+0.2); n.connect(bp); bp.connect(g); n.start(t,Math.random()*0.5,0.25); },
  step(x,z,vol,muffled,bright){
    if(!this.ok()) return; const c=this.ctx, t=c.currentTime;
    const src=c.createBufferSource(); src.buffer=this.noise; src.playbackRate.value=0.6+Math.random()*0.3;
    const f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.value=muffled?160:(bright?900:320);
    const g=c.createGain(); this.env(g,t,0.005,vol*(muffled?0.6:1),0.12);
    let out=g;
    if(x!==null){ const p=c.createPanner(); p.panningModel='HRTF'; p.distanceModel='inverse'; p.refDistance=2; p.rolloffFactor=1.3; p.maxDistance=50;
      if(p.positionX){ p.positionX.value=x; p.positionY.value=0.2; p.positionZ.value=z; } else p.setPosition(x,0.2,z); g.connect(p); out=p; }
    src.connect(f); f.connect(g); out.connect(this.master); src.start(t,Math.random()*0.5,0.2);
  },
  sting(){
    if(!this.ok()) return; const c=this.ctx, t=c.currentTime, g=c.createGain(); this.env(g,t,0.015,0.22,1.6); g.connect(this.master);
    [196,207.6,293.7,415].forEach(f=>{ const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(f,t); o.frequency.linearRampToValueAtTime(f*0.94,t+1.6); o.connect(g); o.start(t); o.stop(t+1.8); });
    const n=c.createBufferSource(); n.buffer=this.noise; const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=2500; n.connect(hp); hp.connect(g); n.start(t,0,0.9);
  },
  crunch(){
    if(!this.ok()) return; const c=this.ctx, t=c.currentTime, g=c.createGain(); this.env(g,t,0.01,0.5,0.6); g.connect(this.master);
    const n=c.createBufferSource(); n.buffer=this.noise; n.playbackRate.value=0.4; const lp=c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=700; n.connect(lp); lp.connect(g); n.start(t,0,0.7);
    this.thump(0.6);
  },
  zap(vol){
    if(!this.ok()) return; const c=this.ctx, t=c.currentTime, g=c.createGain(); this.env(g,t,0.003,vol,0.06+Math.random()*0.08); g.connect(this.master);
    const n=c.createBufferSource(); n.buffer=this.noise; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2000+Math.random()*3000; bp.Q.value=2; n.connect(bp); bp.connect(g); n.start(t,Math.random()*0.5,0.15);
    const o=c.createOscillator(); o.type='square'; o.frequency.value=120; const og=c.createGain(); og.gain.value=0.35; o.connect(og); og.connect(g); o.start(t); o.stop(t+0.12);
  },
  clank(){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.003,0.25,0.3); g.connect(this.master);
    const n=c.createBufferSource(); n.buffer=this.noise; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=2600; bp.Q.value=4; n.connect(bp); bp.connect(g); n.start(t,0,0.3);
    [880,1390,2210].forEach(f=>{ const o=c.createOscillator(); o.frequency.value=f; const og=c.createGain(); og.gain.value=0.25; o.connect(og); og.connect(g); o.start(t); o.stop(t+0.35); }); },
  giggle(vol){ if(!this.ok()) return; const c=this.ctx,t0=c.currentTime;
    for(let k=0;k<7;k++){ const t=t0+k*0.11+Math.random()*0.03, o=c.createOscillator(), g=c.createGain(), f=520+Math.random()*380; o.type='triangle';
      o.frequency.setValueAtTime(f,t); o.frequency.exponentialRampToValueAtTime(f*1.35,t+0.07); this.env(g,t,0.01,vol,0.08); o.connect(g); g.connect(this.master); o.start(t); o.stop(t+0.12); } },
  entityScream(){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.02,0.6,1.1); g.connect(this.master);
    const ws=c.createWaveShaper(), cv=new Float32Array(1024); for(let i=0;i<1024;i++){ const x=i/512-1; cv[i]=Math.tanh(x*6); } ws.curve=cv; ws.connect(g);
    [72,95,143,190].forEach(f=>{ const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(f,t); o.frequency.exponentialRampToValueAtTime(f*1.7,t+0.5); o.frequency.exponentialRampToValueAtTime(f*0.8,t+1.1);
      const og=c.createGain(); og.gain.value=0.3; o.connect(og); og.connect(ws); o.start(t); o.stop(t+1.2); });
    const n=c.createBufferSource(); n.buffer=this.noise; n.loop=true; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.setValueAtTime(500,t); bp.frequency.exponentialRampToValueAtTime(2200,t+0.6); bp.Q.value=1.2;
    const ng=c.createGain(); ng.gain.value=0.9; n.connect(bp); bp.connect(ng); ng.connect(ws); n.start(t); n.stop(t+1.1);
    const sg=c.createGain(); this.env(sg,t+0.05,0.05,0.12,0.8); sg.connect(this.master);
    const sh=c.createOscillator(); sh.type='sawtooth'; sh.frequency.setValueAtTime(900,t); sh.frequency.exponentialRampToValueAtTime(2300,t+0.7); sh.connect(sg); sh.start(t); sh.stop(t+1);
    this.thump(0.9,1.0); this.thump(0.6,1.08); },
  burst(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.05,0.35,1.2);
    let out=g; if(x!==null){ const pn=c.createPanner(); pn.panningModel='HRTF'; pn.distanceModel='inverse'; pn.refDistance=3; pn.rolloffFactor=1; if(pn.positionX){ pn.positionX.value=x; pn.positionY.value=1.5; pn.positionZ.value=z; } else pn.setPosition(x,1.5,z); g.connect(pn); out=pn; }
    out.connect(this.master);
    const n=c.createBufferSource(); n.buffer=this.noise; n.loop=true; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=3; bp.frequency.setValueAtTime(300,t); bp.frequency.exponentialRampToValueAtTime(3000,t+0.6); n.connect(bp); bp.connect(g); n.start(t); n.stop(t+1.3);
    const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(160,t); o.frequency.exponentialRampToValueAtTime(620,t+0.5); const og=c.createGain(); og.gain.value=0.25; o.connect(og); og.connect(g); o.start(t); o.stop(t+1.2); },
  _out(g,x,z){ if(x===null||x===undefined){ g.connect(this.master); return; } const c=this.ctx, pn=c.createPanner(); pn.panningModel='HRTF'; pn.distanceModel='inverse'; pn.refDistance=2.5; pn.rolloffFactor=1.1;
    if(pn.positionX){ pn.positionX.value=x; pn.positionY.value=1.6; pn.positionZ.value=z; } else pn.setPosition(x,1.6,z); g.connect(pn); pn.connect(this.master); },
  bite(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t+0.12,0.003,0.55,0.18); this._out(g,x,z);
    const n=c.createBufferSource(); n.buffer=this.noise; const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1800; n.connect(hp); hp.connect(g); n.start(t+0.12,0,0.12);
    const o=c.createOscillator(); o.type='square'; o.frequency.setValueAtTime(220,t+0.12); o.frequency.exponentialRampToValueAtTime(60,t+0.22); const og=c.createGain(); og.gain.value=0.5; o.connect(og); og.connect(g); o.start(t+0.12); o.stop(t+0.3);
    const h=c.createGain(); this.env(h,t,0.02,0.12,0.12); this._out(h,x,z); const hn=c.createBufferSource(); hn.buffer=this.noise; const hb=c.createBiquadFilter(); hb.type='bandpass'; hb.frequency.value=900; hn.connect(hb); hb.connect(h); hn.start(t,0.3,0.15); },
  swipe(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.04,0.4,0.22); this._out(g,x,z);
    const n=c.createBufferSource(); n.buffer=this.noise; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=2.5; bp.frequency.setValueAtTime(350,t); bp.frequency.exponentialRampToValueAtTime(2400,t+0.22); n.connect(bp); bp.connect(g); n.start(t,0,0.3); },
  rip(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t+0.25,0.01,0.5,0.7); this._out(g,x,z);
    [520,553,780].forEach(f=>{ const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(f,t+0.25); o.frequency.exponentialRampToValueAtTime(f*0.45,t+0.9); const og=c.createGain(); og.gain.value=0.22; o.connect(og); og.connect(g); o.start(t+0.25); o.stop(t+1); });
    const n=c.createBufferSource(); n.buffer=this.noise; const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1500; n.connect(hp); hp.connect(g); n.start(t+0.25,0,0.6);
    setTimeout(()=>this.clank(),720); },
  powerDown(x,z,big,restore){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.02,big?0.5:0.35,big?1.6:0.9); this._out(g,x,z);
    const o=c.createOscillator(); o.type='sawtooth'; const f0=restore?45:140, f1=restore?140:38; o.frequency.setValueAtTime(f0,t); o.frequency.exponentialRampToValueAtTime(f1,t+(big?1.5:0.8));
    const lp=c.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=600; o.connect(lp); lp.connect(g); o.start(t); o.stop(t+(big?1.7:1));
    if(!restore){ const th=c.createGain(); this.env(th,t,0.005,big?0.7:0.45,0.25); this._out(th,x,z); const n=c.createBufferSource(); n.buffer=this.noise; const bp=c.createBiquadFilter(); bp.type='lowpass'; bp.frequency.value=220; n.connect(bp); bp.connect(th); n.start(t,0,0.3); } },
  disguise(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.05,0.18,0.6); this._out(g,x,z);
    const n=c.createBufferSource(); n.buffer=this.noise; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.Q.value=4; bp.frequency.setValueAtTime(2500,t); bp.frequency.exponentialRampToValueAtTime(300,t+0.6); n.connect(bp); bp.connect(g); n.start(t,0,0.7); },
  reveal(x,z){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.01,0.5,0.7); this._out(g,x,z);
    [180,240,330,470].forEach((f,i)=>{ const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(f,t); o.frequency.exponentialRampToValueAtTime(f*(2.2+i*0.3),t+0.5); o.connect(g); o.start(t); o.stop(t+0.75); });
    const n=c.createBufferSource(); n.buffer=this.noise; const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=1200; n.connect(hp); hp.connect(g); n.start(t,0,0.6); this.thump(0.5,0.05); },
  scream(){ if(!this.ok()) return; const c=this.ctx,t=c.currentTime,g=c.createGain(); this.env(g,t,0.01,0.5,1.3); g.connect(this.master);
    [310,331,467,620].forEach(f=>{ const o=c.createOscillator(); o.type='sawtooth'; o.frequency.setValueAtTime(f,t); o.frequency.exponentialRampToValueAtTime(f*2.6,t+0.9); o.connect(g); o.start(t); o.stop(t+1.4); });
    const n=c.createBufferSource(); n.buffer=this.noise; n.connect(g); n.start(t,0,1); },
  setWhisper(v){ if(!this.ok()) return; const c=this.ctx;
    if(!this.wh){ const n=c.createBufferSource(); n.buffer=this.noise; n.loop=true; const bp=c.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1700; bp.Q.value=3;
      const g=c.createGain(); g.gain.value=0; const lfo=c.createOscillator(); lfo.frequency.value=4.3; const lg=c.createGain(); lg.gain.value=0; lfo.connect(lg); lg.connect(g.gain);
      n.connect(bp); bp.connect(g); g.connect(this.master); n.start(); lfo.start(); this.wh={g,lg,bp}; }
    const t=c.currentTime; this.wh.g.gain.setTargetAtTime(v*0.09,t,0.2); this.wh.lg.gain.setTargetAtTime(v*0.06,t,0.2); this.wh.bp.frequency.setTargetAtTime(1200+Math.random()*1400,t,0.3); },
  listener(x,y,z,yaw){
    if(!this.ctx) return; const L=this.ctx.listener, fx=-Math.sin(yaw), fz=-Math.cos(yaw);
    if(L.positionX){ L.positionX.value=x; L.positionY.value=y; L.positionZ.value=z; L.forwardX.value=fx; L.forwardY.value=0; L.forwardZ.value=fz; L.upX.value=0; L.upY.value=1; L.upZ.value=0; }
    else { L.setPosition(x,y,z); L.setOrientation(fx,0,fz,0,1,0); }
  }
};

/* =====================================================================
   RENDERER, POST-PROCESSING + WORLD BUILD  (client/render.ts)
   ===================================================================== */
const canvas=document.getElementById('view'), ov=document.getElementById('ov'), ovg=ov.getContext('2d');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
const camera=new THREE.PerspectiveCamera(74,1,0.05,60); camera.rotation.order='YXZ';
let composer=null, renderPass=null, bloomPass=null, finalPass=null;
const POST_OK=()=>!!(THREE.EffectComposer&&THREE.RenderPass&&THREE.ShaderPass&&THREE.UnrealBloomPass&&THREE.CopyShader&&THREE.LuminosityHighPassShader);
const HI=()=>SET.gfx==='high'&&POST_OK();
const FINAL_SHADER={
  uniforms:{tDiffuse:{value:null},time:{value:0},fear:{value:0},insane:{value:0},exposure:{value:0.95}},
  vertexShader:'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader:`uniform sampler2D tDiffuse; uniform float time; uniform float fear; uniform float insane; uniform float exposure; varying vec2 vUv;
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
    float rnd(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec2 uv=vUv; uv+=vec2(sin(uv.y*22.0+time*3.1),cos(uv.x*17.0+time*2.3))*0.006*insane;
      float row=floor(uv.y*60.0); if(rnd(vec2(row,floor(time*14.0)))>1.0-0.25*insane) uv.x+=(rnd(vec2(row,time))-0.5)*0.06*insane;
      vec2 d=uv-0.5; float r2=dot(d,d); float ca=0.0012+0.006*fear+0.02*insane;
      vec3 c=vec3(texture2D(tDiffuse,uv+d*ca).r, texture2D(tDiffuse,uv).g, texture2D(tDiffuse,uv-d*ca).b);
      c=aces(c*exposure); c=pow(c,vec3(1.0/2.2));
      float l=dot(c,vec3(0.299,0.587,0.114)); c=mix(vec3(l),c,0.85-0.6*insane); c*=1.0-0.35*insane; c*=vec3(1.03,1.0,0.87);
      c*=1.0-smoothstep(0.1,0.65,r2)*0.8;
      c+=(rnd(vUv*vec2(1733.0,977.0)+fract(time*7.13))-0.5)*(0.05+0.18*insane);
      gl_FragColor=vec4(c,1.0);
    }`
};
function setupRenderer(){
  if(HI()){
    renderer.setPixelRatio(Math.min(devicePixelRatio,1.25)); renderer.toneMapping=THREE.NoToneMapping; renderer.outputEncoding=THREE.LinearEncoding;
    if(!composer){
      const rt=new THREE.WebGLRenderTarget(innerWidth,innerHeight,{type:THREE.HalfFloatType,format:THREE.RGBAFormat});
      composer=new THREE.EffectComposer(renderer,rt);
      renderPass=new THREE.RenderPass(new THREE.Scene(),camera); composer.addPass(renderPass);
      bloomPass=new THREE.UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.65,0.5,1.1); composer.addPass(bloomPass);
      finalPass=new THREE.ShaderPass(FINAL_SHADER); composer.addPass(finalPass);
    }
  } else { renderer.setPixelRatio(1); renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=0.95; renderer.outputEncoding=THREE.sRGBEncoding; }
  resize();
}
function resize(){
  const w=innerWidth, hh=innerHeight; renderer.setSize(w,hh,false);
  if(composer){ if(composer.setPixelRatio) composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w,hh); }
  camera.aspect=w/hh; camera.updateProjectionMatrix(); ov.width=w; ov.height=hh;
}
addEventListener('resize',resize); resize();
function renderFrame(scene,dt,fear,insane){
  if(HI()&&composer){ renderPass.scene=scene; finalPass.uniforms.time.value+=dt; finalPass.uniforms.fear.value=fear||0; finalPass.uniforms.insane.value=insane||0; composer.render(dt); }
  else renderer.render(scene,camera);
}

const FOG=srgb(0x241e0e); let PUDDLE_TEX=null;
// baked contact shadows along walls + damp/water stains, laid over floor or ceiling
function stainOverlay(map,ceiling){
  const ppm=8, W=map.N*map.S, px=Math.round(W*ppm), c=mkCanvas(px,px), g=c.getContext('2d');
  const n=Math.round(map.N*map.N*(ceiling?0.12:0.2));
  for(let i=0;i<n;i++){ const x=Math.random()*px, y=Math.random()*px, r=(1+Math.random()*3.5)*ppm;
    if(ceiling){ blob(g,x,y,r,'rgba(110,80,25,A)',0.45); g.strokeStyle='rgba(90,62,18,.35)'; g.lineWidth=1.5; g.beginPath(); g.ellipse(x,y,r*0.75,r*0.6,Math.random()*3,0,6.3); g.stroke(); }
    else blob(g,x,y,r,'rgba(20,14,4,A)',0.4); }
  if(!ceiling&&map.wet) for(const c of map.wet){ const cx=(c%map.N+0.5)*map.S*ppm, cy=(((c/map.N)|0)+0.5)*map.S*ppm; for(let k=0;k<3;k++) blob(g,cx+(Math.random()-0.5)*map.S*ppm*0.6,cy+(Math.random()-0.5)*map.S*ppm*0.6,map.S*ppm*(0.55+Math.random()*0.3),'rgba(18,12,3,A)',0.5); }
  const {N,S,h,v}=map;
  g.filter='blur('+(ppm*0.55)+'px)'; g.strokeStyle='rgba(0,0,0,'+(ceiling?0.5:0.75)+')'; g.lineWidth=ppm*0.9; g.beginPath();
  for(let y=0;y<=N;y++) for(let x=0;x<N;x++) if(h[y][x]){ g.moveTo(x*S*ppm,y*S*ppm); g.lineTo((x+1)*S*ppm,y*S*ppm); }
  for(let y=0;y<N;y++) for(let x=0;x<=N;x++) if(v[y][x]){ g.moveTo(x*S*ppm,y*S*ppm); g.lineTo(x*S*ppm,(y+1)*S*ppm); }
  g.stroke(); g.fillStyle='rgba(0,0,0,.6)'; for(const p of map.pillars) g.fillRect((p.x*S-0.55)*ppm,(p.y*S-0.55)*ppm,1.1*ppm,1.1*ppm);
  g.filter='none';
  const t=new THREE.CanvasTexture(c); t.encoding=THREE.sRGBEncoding; t.anisotropy=8; if(ceiling) t.flipY=false;
  return new THREE.MeshBasicMaterial({map:t,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
}
function buildScene(map){
  if(!TEX) TEX=makeTextures();
  const scene=new THREE.Scene(); scene.background=FOG.clone(); scene.fog=new THREE.Fog(FOG,CONFIG.fogFar<20?1:2,CONFIG.fogFar);
  const {N,S}=map, H=CONFIG.wallHeight, T=CONFIG.wallThick, W=N*S;
  const hemi=new THREE.HemisphereLight(srgb(0xe8d39a),srgb(0x4d4120),0.3); scene.add(hemi);
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), one=new THREE.Vector3(1,1,1), p=new THREE.Vector3(), rot=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);
  // walls: 3 wallpaper variants so damage doesn't visibly repeat
  const wallMats=TEX.walls.map(t=>new THREE.MeshStandardMaterial({map:t.map,normalMap:t.normal,normalScale:new THREE.Vector2(0.7,0.7),roughness:0.86,metalness:0}));
  const segs=[];
  for(let y=0;y<=N;y++) for(let x=0;x<N;x++) if(map.h[y][x]) segs.push({x:(x+0.5)*S,z:y*S,r:0});
  for(let y=0;y<N;y++) for(let x=0;x<=N;x++) if(map.v[y][x]) segs.push({x:x*S,z:(y+0.5)*S,r:1});
  const groups=[[],[],[]]; segs.forEach((s,i)=>groups[(i*7+((s.x*13+s.z*7)|0))%3].push(s));
  const wallGeo=new THREE.BoxGeometry(S+T,H,T);
  groups.forEach((gr,vi)=>{ if(!gr.length) return; const im=new THREE.InstancedMesh(wallGeo,wallMats[vi],gr.length);
    gr.forEach((s,k)=>{ p.set(s.x,H/2,s.z); m.compose(p,s.r?rot:q,one); im.setMatrixAt(k,m); }); scene.add(im); });
  if(map.pillars.length){
    const pg=new THREE.BoxGeometry(0.6,H,0.6), uv=pg.attributes.uv; for(let i=0;i<uv.count;i++) uv.setX(i,uv.getX(i)*0.6/(S+T));
    const pil=new THREE.InstancedMesh(pg,wallMats[0],map.pillars.length);
    map.pillars.forEach((pp,k)=>{ p.set(pp.x*S,H/2,pp.y*S); m.compose(p,q,one); pil.setMatrixAt(k,m); }); scene.add(pil);
  }
  // floor + ceiling + baked overlays
  const cm=TEX.carpet.map.clone(), cn=TEX.carpet.normal.clone(); [cm,cn].forEach(t=>{ t.repeat.set(W/2,W/2); t.needsUpdate=true; });
  const fl=new THREE.Mesh(new THREE.PlaneGeometry(W,W),new THREE.MeshStandardMaterial({map:cm,normalMap:cn,roughness:1,metalness:0}));
  fl.rotation.x=-Math.PI/2; fl.position.set(W/2,0,W/2); scene.add(fl);
  if(map.wet.size){   // glossy soaked patches that catch the light
    if(!PUDDLE_TEX){ const c=mkCanvas(128,128), g=c.getContext('2d'); const gr=g.createRadialGradient(64,64,10,64,64,64); gr.addColorStop(0,'#fff'); gr.addColorStop(0.6,'#bbb'); gr.addColorStop(1,'#000'); g.fillStyle=gr; g.fillRect(0,0,128,128); PUDDLE_TEX=new THREE.CanvasTexture(c); }
    const pg=new THREE.PlaneGeometry(S*1.35,S*1.35); pg.rotateX(-Math.PI/2);
    const wm=new THREE.InstancedMesh(pg,new THREE.MeshStandardMaterial({color:srgb(0x241a08),roughness:0.08,metalness:0.1,transparent:true,opacity:0.6,alphaMap:PUDDLE_TEX,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3}),map.wet.size);
    let k=0; for(const c of map.wet){ p.set((c%N+0.5)*S,0.006,(((c/N)|0)+0.5)*S); m.compose(p,new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),(c*1.7)%6.28),one); wm.setMatrixAt(k++,m); }
    scene.add(wm); }
  const fo=new THREE.Mesh(new THREE.PlaneGeometry(W,W),stainOverlay(map,false)); fo.rotation.x=-Math.PI/2; fo.position.set(W/2,0.004,W/2); scene.add(fo);
  const tm=TEX.ceil.map.clone(), tn=TEX.ceil.normal.clone(); [tm,tn].forEach(t=>{ t.repeat.set(W/1.2,W/1.2); t.needsUpdate=true; });
  const ce=new THREE.Mesh(new THREE.PlaneGeometry(W,W),new THREE.MeshStandardMaterial({map:tm,normalMap:tn,roughness:0.93,metalness:0}));
  ce.rotation.x=Math.PI/2; ce.position.set(W/2,H,W/2); scene.add(ce);
  const co=new THREE.Mesh(new THREE.PlaneGeometry(W,W),stainOverlay(map,true)); co.rotation.x=Math.PI/2; co.position.set(W/2,H-0.004,W/2); scene.add(co);
  // fluorescent troffers: metal housing + glowing diffuser (instanced, per-light brightness)
  const frames=new THREE.InstancedMesh(new THREE.BoxGeometry(1.26,0.07,0.66),new THREE.MeshStandardMaterial({color:srgb(0xd6d3c8),roughness:0.45,metalness:0.5}),map.lights.length);
  const dg=new THREE.PlaneGeometry(1.14,0.54); dg.rotateX(Math.PI/2);
  const glow=HI()?new THREE.Color(6.5,6.0,5.0):new THREE.Color(1.7,1.6,1.35);
  const panels=new THREE.InstancedMesh(dg,new THREE.MeshBasicMaterial({color:glow}),map.lights.length);
  const col=new THREE.Color();
  map.lights.forEach((L,k)=>{ p.set(L.x,H-0.03,L.z); m.compose(p,q,one); frames.setMatrixAt(k,m);
    p.set(L.x,H-0.068,L.z); m.compose(p,q,one); panels.setMatrixAt(k,m); col.setRGB(1,0.95,0.85).multiplyScalar(L.state==='dead'?0.02:1); panels.setColorAt(k,col); });
  scene.add(frames); scene.add(panels);
  // pooled real lights near the camera (fixed count so shaders never recompile)
  const pool=[]; for(let k=0;k<(HI()?8:5);k++){ const pl=new THREE.PointLight(srgb(0xfff0cf),0,11,2); pl.position.y=H-0.45; scene.add(pl); pool.push(pl); }
  // dust in the air
  const DN=450, pos=new Float32Array(DN*3); for(let i=0;i<DN;i++){ pos[i*3]=(Math.random()-0.5)*16; pos[i*3+1]=0.2+Math.random()*2.7; pos[i*3+2]=(Math.random()-0.5)*16; }
  const mg=new THREE.BufferGeometry(); mg.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const motes=new THREE.Points(mg,new THREE.PointsMaterial({color:new THREE.Color(1.4,1.3,1.05),size:0.011,transparent:true,opacity:0.32,depthWrite:false})); motes.frustumCulled=false; scene.add(motes);
  return {scene,panels,pool,motes,hemi};
}
function updateMotes(motes,cam,dt,t){
  const a=motes.geometry.attributes.position, d=a.array;
  for(let i=0;i<a.count;i++){ const j=i*3;
    d[j]+=Math.sin(t*0.3+i)*dt*0.06; d[j+1]+=(Math.sin(t*0.5+i*1.7)*0.04-0.012)*dt; d[j+2]+=Math.cos(t*0.27+i*0.7)*dt*0.06;
    if(d[j]-cam.x>8) d[j]-=16; else if(d[j]-cam.x<-8) d[j]+=16;
    if(d[j+2]-cam.z>8) d[j+2]-=16; else if(d[j+2]-cam.z<-8) d[j+2]+=16;
    if(d[j+1]<0.1) d[j+1]=2.9; else if(d[j+1]>2.95) d[j+1]=0.15; }
  a.needsUpdate=true;
}
function radialTex(inner,outer){ const c=document.createElement('canvas'); c.width=c.height=64; const g=c.getContext('2d'); const gr=g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,inner); gr.addColorStop(1,outer); g.fillStyle=gr; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c); }
let GLOW_TEX=null, HAZE_TEX=null;
function makeEntityMesh(){
  if(!GLOW_TEX){ GLOW_TEX=radialTex('rgba(255,245,215,1)','rgba(255,245,215,0)'); HAZE_TEX=radialTex('rgba(0,0,0,0.9)','rgba(0,0,0,0)'); }
  const root=new THREE.Group();
  const skin=new THREE.MeshPhysicalMaterial({map:TEX.skin.map,normalMap:TEX.skin.normal,normalScale:new THREE.Vector2(1.3,1.3),roughness:0.58,metalness:0,clearcoat:0.6,clearcoatRoughness:0.35});  // wet necrotic skin
  const bone=new THREE.MeshStandardMaterial({color:srgb(0x4b4234),roughness:0.5});
  const inner=new THREE.MeshStandardMaterial({color:srgb(0x2a0707),roughness:0.22});
  const toothM=new THREE.MeshStandardMaterial({color:srgb(0xb0a585),roughness:0.35});
  const eyeM=new THREE.MeshStandardMaterial({color:srgb(0xb9b6a6),roughness:0.08,emissive:srgb(0xcfc9b2),emissiveIntensity:HI()?1.6:0.8,fog:false});
  // limb segment: tapered sinewy lathe, pivot at joint; runs along +y (dir=1) or -y (dir=-1); children attach to .end
  function limbGeo(len,r0,r1){ r0*=1.4; r1*=1.4; const a=(r0+r1)/2; return lathe([[r0*0.55,0],[r0*1.25,len*0.05],[r0*0.95,len*0.14],[a*1.1,len*0.4],[a*1.25,len*0.6],[r1,len*0.86],[r1*1.15,len*0.94],[r1*0.6,len]],9); }
  function seg(parent,len,r0,r1,dir,mat){ mat=mat||skin; const pv=new THREE.Group(); const geo=limbGeo(len,r0,r1); if(dir<0) geo.rotateX(Math.PI);
    pv.add(new THREE.Mesh(geo,mat)); const end=new THREE.Group(); end.position.y=dir*len; pv.add(end); parent.add(pv); return {pv,end}; }

  // hips + digitigrade (backwards-knee) legs
  const hips=new THREE.Group(); hips.position.y=1.55; root.add(hips);
  const pelvis=new THREE.Mesh(new THREE.SphereGeometry(0.15,8,6),skin); pelvis.scale.set(1.35,0.7,0.9); hips.add(pelvis);
  const legs=[-1,1].map(s=>{ const hj=new THREE.Group(); hj.position.x=s*0.15; hips.add(hj);
    const th=seg(hj,0.72,0.07,0.04,-1); th.pv.rotation.x=0.6;
    const sh=seg(th.end,0.78,0.04,0.028,-1); sh.pv.rotation.x=-1.3;
    const ft=seg(sh.end,0.45,0.028,0.018,-1); ft.pv.rotation.x=0.9;
    for(let k=-1;k<=1;k++){ const t=seg(ft.end,0.24,0.014,0.003,-1,bone); t.pv.rotation.set(1.35,0,k*0.4); }
    return {th,sh,ft}; });

  // hunched spine with spikes and an exposed ribcage
  const spine=[]; let cur=hips;
  for(let k=0;k<7;k++){
    const s=seg(cur,0.21,0.06-k*0.004,0.055-k*0.004,1); s.base=k===0?-0.15:-0.17; s.pv.rotation.x=s.base; spine.push(s); cur=s.end;
    const spike=new THREE.Mesh(new THREE.ConeGeometry(0.022,0.16+((k*37)%5)*0.02,4),bone); spike.position.set(0,0.1,0.06); spike.rotation.x=1.15; s.pv.add(spike);
    if(k>=2&&k<=5){ const rib=new THREE.Mesh(new THREE.TorusGeometry(0.18-(k-2)*0.014,0.011,4,12,Math.PI*1.35),bone);
      rib.rotation.set(Math.PI/2,0,0.825*Math.PI); rib.position.set(0,0.1,-0.04); rib.scale.x=1.15; s.pv.add(rib); }
  }
  const chest=cur; let lean=0; spine.forEach(s=>lean+=s.base);
  const clav=new THREE.Mesh(new THREE.CylinderGeometry(0.028,0.028,0.56,5),skin); clav.rotation.z=Math.PI/2; chest.add(clav);
  // gaunt torso stretched over the ribs, plus clusters of growths (bacterial colonies) on the back and shoulders
  spine.forEach((sg,k)=>{ if(k<1||k>5) return; const f=new THREE.Mesh(new THREE.SphereGeometry(0.11,9,7),skin); f.scale.set(1.25-(k>3?0.2:0),1.25,0.85); f.position.set(0,0.1,0.02); sg.pv.add(f); });
  const growth=(parent,n,sx,sy,sz,cz)=>{ for(let i=0;i<n;i++){ const r=0.025+Math.random()*0.06; const g=new THREE.Mesh(new THREE.SphereGeometry(r,7,5),i%3?skin:bone);
    g.position.set((Math.random()-0.5)*sx,(Math.random()-0.5)*sy,cz+Math.random()*sz); g.scale.set(1,0.7+Math.random()*0.6,1); parent.add(g); } };
  growth(chest,16,0.7,0.25,0.14,0.02); growth(spine[3].pv,10,0.25,0.3,0.12,0.06); growth(spine[5].pv,8,0.3,0.25,0.1,0.07);

  // arms: three joints each, long enough to drag on the floor, long claw fingers
  const arms=[-1,1].map(s=>{ const sj=new THREE.Group(); sj.position.x=s*0.28; chest.add(sj);
    const up=seg(sj,0.85,0.06,0.035,-1); up.base=0.3-lean; up.pv.rotation.x=up.base; up.pv.rotation.z=s*0.15;
    const fo=seg(up.end,0.9,0.035,0.024,-1); fo.pv.rotation.x=-0.25;
    const ex=seg(fo.end,0.45,0.02,0.016,-1); ex.pv.rotation.x=0.35;
    const fingers=[]; for(let f=0;f<4;f++){ const a=seg(ex.end,0.3,0.012,0.008,-1,bone); a.pv.rotation.set(0.25,0,(f-1.5)*0.28*s);
      const b=seg(a.end,0.26,0.008,0.002,-1,bone); b.pv.rotation.x=0.45; fingers.push({a,b}); }
    return {up,fo,ex,fingers,side:s}; });

  // neck that juts forward, head that counter-rotates so it always faces ahead
  const neck=[]; cur=chest; let nl=0; [-0.12,-0.08,0.1,0.18].forEach(r=>{ const n=seg(cur,0.15,0.035,0.03,1); n.pv.rotation.x=r; n.base=r; nl+=r; neck.push(n); cur=n.end; });
  const head=new THREE.Group(); head.rotation.order='XYZ'; head.baseX=-(lean+nl); head.rotation.x=head.baseX; head.scale.setScalar(1.55); cur.add(head);
  const skull=new THREE.Mesh(new THREE.SphereGeometry(0.15,12,10),skin); skull.scale.set(0.85,0.85,1.65); skull.position.set(0,0.06,-0.12); head.add(skull);
  const brow=new THREE.Mesh(new THREE.SphereGeometry(0.1,8,6),skin); brow.scale.set(1.2,0.5,1.2); brow.position.set(0,0.13,-0.05); head.add(brow);
  const maw=new THREE.Mesh(new THREE.SphereGeometry(0.12,10,8),inner); maw.scale.set(0.62,0.38,1.45); maw.position.set(0,-0.02,-0.15); head.add(maw);
  for(let i=0;i<12;i++){ const side=i%2?1:-1, j=Math.floor(i/2), z=-0.05-j*0.05, x=side*(0.085-j*0.012);
    const t=new THREE.Mesh(new THREE.ConeGeometry(0.011,0.06+(i%3)*0.02,4),toothM); t.position.set(x,-0.02,z); t.rotation.x=Math.PI; head.add(t); }
  const jaw=new THREE.Group(); jaw.position.set(0,-0.03,0.0); head.add(jaw);
  const jm=new THREE.Mesh(new THREE.SphereGeometry(0.13,10,6,0,Math.PI*2,Math.PI/2,Math.PI/2),skin); jm.scale.set(0.78,0.55,1.55); jm.position.z=-0.12; jaw.add(jm);
  for(let i=0;i<10;i++){ const side=i%2?1:-1, j=Math.floor(i/2), z=-0.07-j*0.05, x=side*(0.075-j*0.012);
    const t=new THREE.Mesh(new THREE.ConeGeometry(0.01,0.06+(i%2)*0.025,4),toothM); t.position.set(x,0.0,z); jaw.add(t); }
  // too many eyes, asymmetric, unaffected by fog so they shine out of the dark
  const eyes=[[-0.055,0.12,-0.3,0.016],[0.06,0.11,-0.28,0.019],[0.015,0.16,-0.22,0.011],[-0.09,0.08,-0.2,0.012],[0.095,0.14,-0.17,0.01],[-0.03,0.17,-0.15,0.009]];
  eyes.forEach(([x,y,z,r])=>{ const e=new THREE.Mesh(new THREE.SphereGeometry(r,6,5),eyeM); e.position.set(x,y,z); head.add(e);
    const gl=new THREE.Sprite(new THREE.SpriteMaterial({map:GLOW_TEX,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,opacity:0.25})); gl.scale.setScalar(r*5); gl.position.set(x,y,z-0.01); head.add(gl); });

  // hidden split-face maw: only opens during the jumpscare
  const sMaw=new THREE.Group(); sMaw.position.set(0,-0.02,-0.36); sMaw.visible=false; head.add(sMaw);
  const tc=mkCanvas(256,256), tg=tc.getContext('2d'), rg=tg.createRadialGradient(128,128,4,128,128,128);
  rg.addColorStop(0,'#000'); rg.addColorStop(0.32,'#050000'); rg.addColorStop(0.6,'#2e0405'); rg.addColorStop(0.85,'#5e0c0c'); rg.addColorStop(1,'#3a0606'); tg.fillStyle=rg; tg.fillRect(0,0,256,256);
  for(let i=0;i<40;i++){ const a=Math.random()*6.3, r0=40+Math.random()*30, r1=r0+20+Math.random()*60; tg.strokeStyle=`rgba(${120+Math.random()*80},20,20,${0.15+Math.random()*0.3})`; tg.lineWidth=1+Math.random()*3; tg.beginPath(); tg.moveTo(128+Math.cos(a)*r0,128+Math.sin(a)*r0); tg.lineTo(128+Math.cos(a+0.1)*r1,128+Math.sin(a+0.1)*r1); tg.stroke(); }
  const ttex=new THREE.CanvasTexture(tc); ttex.encoding=THREE.sRGBEncoding;
  const throat=new THREE.Mesh(new THREE.CircleGeometry(0.15,28),new THREE.MeshStandardMaterial({map:ttex,roughness:0.15,metalness:0,side:THREE.DoubleSide})); throat.position.z=0.1; sMaw.add(throat);
  const gullet=new THREE.Mesh(new THREE.CircleGeometry(0.05,12),new THREE.MeshBasicMaterial({color:0x000000})); gullet.position.z=0.29; gullet.rotation.y=Math.PI; sMaw.add(gullet);
  for(let ring=0;ring<2;ring++) for(let i=0;i<14;i++){ const a=i/14*Math.PI*2+ring*0.22, r=0.12-ring*0.045;
    const jt=(Math.random()-0.5)*0.25; const tooth=new THREE.Mesh(new THREE.ConeGeometry(0.006+Math.random()*0.005,(0.03+Math.random()*0.035)-ring*0.008,4),toothM); tooth.position.set(Math.cos(a+jt)*r,Math.sin(a+jt)*r,0.02+ring*0.05);
    tooth.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(-Math.cos(a)*0.8+(Math.random()-0.5)*0.4,-Math.sin(a)*0.8+(Math.random()-0.5)*0.4,0.4).normalize()); sMaw.add(tooth); }
  const petals=[]; for(let i=0;i<4;i++){ const a=i/4*Math.PI*2+Math.PI/4, pv=new THREE.Group(); pv.position.set(Math.cos(a)*0.12,Math.sin(a)*0.12,0); pv.rotation.z=a-Math.PI/2; sMaw.add(pv);
    const pg=new THREE.PlaneGeometry(0.15,0.24,1,3); pg.translate(0,0.12,0); const pm=new THREE.Mesh(pg,new THREE.MeshPhysicalMaterial({map:TEX.skin.map,normalMap:TEX.skin.normal,color:srgb(0x8a8079),roughness:0.5,clearcoat:0.7,clearcoatRoughness:0.3,side:THREE.DoubleSide})); pv.add(pm);
    const lip=new THREE.Mesh(new THREE.PlaneGeometry(0.13,0.2),new THREE.MeshStandardMaterial({color:srgb(0x4a0a0a),roughness:0.25,side:THREE.DoubleSide})); lip.position.set(0,0.12,-0.004); pv.add(lip);
    for(let k=0;k<3;k++){ const tt=new THREE.Mesh(new THREE.ConeGeometry(0.007,0.04,4),toothM); tt.position.set((k-1)*0.045,0.04+k%2*0.05,-0.02); tt.rotation.x=-Math.PI/2; pv.add(tt); }
    petals.push(pv); }
  // dark haze that clings to it
  const haze=[]; for(let i=0;i<5;i++){ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:HAZE_TEX,depthWrite:false,opacity:0.32}));
    sp.userData={a:i/9*Math.PI*2,r:0.35+Math.random()*0.35,y:0.5+Math.random()*2,sp:0.4+Math.random()*0.6,s:0.9+Math.random()*0.8}; root.add(sp); haze.push(sp); }

  root.userData={hips,legs,arms,spine,neck,head,jaw,haze,maw:sMaw,petals,c:0,track:0,tw:{y:0,z:0},twT:0};
  return root;
}
// smooth a value toward a target (frame-rate independent); r = 1-exp(-rate*dt)
const SM=(o,k,v,r)=>{ o[k]+=(v-o[k])*r; };
const STEP_LEN={idle:0.72,walk:0.72,sprint:1.12,crouch:0.45};   // meters per footstep
function animateEntity(m,dt,t){
  const u=m.mesh.userData, v=(m.vel!==undefined)?m.vel:(m.moving?(m.state==='chase'?4.65:3.35):0);
  const w=clamp(v/3.4,0,1), hunt=!m.frozen&&(m.state==='chase'||m.burstT>0)&&w>0.25;
  const R=1-Math.exp(-16*dt), Rs=1-Math.exp(-7*dt), Rh=1-Math.exp(-30*dt);
  m.walkPhase+=dt*v/2.8*Math.PI*2;                        // one full stride per 2.8 m actually travelled: no foot sliding
  const ph=m.walkPhase;
  let atk=null; if(m.atk){ m.atk.t+=dt; const dur=m.atk.type==='bite'?0.4:m.atk.type==='rip'?1.0:0.5; if(m.atk.t>dur) m.atk=null; else atk={type:m.atk.type,side:m.atk.side,q:m.atk.t/dur}; }
  const aS=atk?Math.sin(atk.q*Math.PI):0, rip=(atk&&atk.type==='rip')?(atk.q<0.55?Math.sin(atk.q/0.55*Math.PI/2):1-(atk.q-0.55)/0.45*1.4):0, grab=atk&&atk.type==='rip'&&atk.q>0.45;
  // legs: long backwards-knee stride, knee lifts during the swing
  u.c+=((m.crouching?1:0)-u.c)*(1-Math.exp(-8*dt)); const cr=u.c;
  SM(u.hips.position,'y',1.55-cr*0.6,R);
  u.legs.forEach((L,i)=>{ const p=ph+(i?Math.PI:0), s=Math.sin(p), lift=Math.max(0,Math.sin(p+1.3));
    SM(L.th.pv.rotation,'x',0.6+s*0.42*w+cr*0.6,R); SM(L.sh.pv.rotation,'x',-1.3-lift*0.6*w-cr*0.7,R); SM(L.ft.pv.rotation,'x',0.9-s*0.22*w+lift*0.35*w+cr*0.35,R); });
  // arms: heavy and lagging; raise and reach when hunting; one sweeps across on a swipe
  u.arms.forEach((A,i)=>{ const sa=Math.sin(ph+(i?0:Math.PI)-0.7)*w, sw=(atk&&atk.type==='swipe'&&atk.side===A.side)?aS:0;
    SM(A.up.pv.rotation,'x',A.up.base+sa*0.16+(hunt?0.95:0)+Math.sin(t*0.9+i*2)*0.03+sw*1.1+rip*1.25,(sw||rip)?Rh:Rs);
    SM(A.up.pv.rotation,'z',A.side*(0.15+(hunt?0.28:0))+(sw?A.side*(0.9-atk.q*1.7):0),sw?Rh:Rs);
    SM(A.fo.pv.rotation,'x',-0.25-(hunt?0.6:0)+Math.max(0,sa)*0.12-sw*0.3-rip*0.35,rip?Rh:Rs); SM(A.ex.pv.rotation,'x',0.35-(hunt?0.35:0),Rs);
    A.fingers.forEach((F,k)=>{ SM(F.a.pv.rotation,'x',0.25-(hunt?0.3:0)+Math.sin(t*(2.6+k*0.7)+i)*0.09-sw*0.4+(grab?0.7:0),R); SM(F.b.pv.rotation,'x',0.45+Math.sin(t*(3.3+k*0.9)+i*1.7)*0.1,R); }); });
  // spine: slow breathing, slight sway with the stride
  u.spine.forEach((s,k)=>{ SM(s.pv.rotation,'x',s.base+Math.sin(t*1.3-k*0.5)*0.015+(hunt?-0.04:0),Rs); SM(s.pv.rotation,'z',Math.sin(ph-k*0.3)*0.025*w-(m.lean||0)*0.07,Rs); });
  if(u.neck&&u.neck[0]) SM(u.neck[0].pv.rotation,'x',u.neck[0].base-(atk&&atk.type==='bite'?aS*0.55:0),Rh);   // neck lunges on a bite
  // head locks onto the camera; twitches are fast but eased, never single-frame snaps
  const cam=camera.position, want=clamp(angDiff(m.yaw,Math.atan2(-(cam.x-m.pos.x),-(cam.z-m.pos.z))),-1.4,1.4);
  u.track+=(want-u.track)*(1-Math.exp(-(m.frozen?1.2:3.5)*dt));
  u.twT-=dt; if(u.twT<=0){ u.twT=1.2+Math.random()*2.6; if(Math.random()<0.55){ u.twTarget={y:(Math.random()-0.5)*0.7,z:Math.random()<0.25?(Math.random()<0.5?-1:1)*1.1:(Math.random()-0.5)*0.4}; u.twHold=0.25+Math.random()*0.5; } }
  if(u.twTarget){ u.twHold-=dt; if(u.twHold<=0) u.twTarget=null; }
  u.tw.y+=((u.twTarget?u.twTarget.y:0)-u.tw.y)*Rh; u.tw.z+=((u.twTarget?u.twTarget.z:0)-u.tw.z)*(1-Math.exp(-18*dt));
  u.head.rotation.x=u.head.baseX+Math.sin(t*1.7)*0.03; u.head.rotation.y=u.track+u.tw.y; u.head.rotation.z=u.tw.z+Math.sin(t*1.1)*0.06;
  // jaw: slack at rest, gaping while hunting, open-then-snap on a bite
  let jt=m.frozen?0.02:hunt?0.5+Math.sin(t*5)*0.12:0.1+Math.sin(t*1.2)*0.05; if(atk&&atk.type==='bite') jt=atk.q<0.5?0.95:0.0;
  SM(u.jaw.rotation,'x',-jt,atk?Rh:R);
  u.haze.forEach(sp=>{ const d=sp.userData; d.a+=dt*d.sp; sp.position.set(Math.cos(d.a)*d.r,d.y+Math.sin(t*0.7+d.a)*0.15,Math.sin(d.a)*d.r-0.3); sp.scale.setScalar(d.s*(1+Math.sin(t*1.7+d.a)*0.15)); });
  // rare, small glitch skip
  let gx=0, gz=0; if(!m.frozen&&Math.random()<dt*0.25){ gx=(Math.random()-0.5)*0.1; gz=(Math.random()-0.5)*0.1; }
  m.mesh.position.x+=gx; m.mesh.position.z+=gz; m.mesh.position.y=Math.abs(Math.sin(ph))*0.05*w;
}
const TEAM_COLORS=[0x2f6fd6,0xd03a2a,0x2fa84a,0x8d4fd6,0xe0902a];   // one armband color per survivor
const lathe=(pts,seg)=>new THREE.LatheGeometry(pts.map(([r,y])=>new THREE.Vector2(Math.max(r,0.0005),y)),seg||14);
// hazmat suit survivor: baggy yellow suit, hood with dark visor, respirator, air tank, team-color armband
function makeSurvivorMesh(i){
  const root=new THREE.Group();
  const suit=new THREE.MeshStandardMaterial({map:TEX.suit.map,normalMap:TEX.suit.normal,normalScale:new THREE.Vector2(1,1),roughness:0.6,metalness:0});
  const rubber=new THREE.MeshStandardMaterial({color:srgb(0x1c1c1b),roughness:0.72});
  const metal=new THREE.MeshStandardMaterial({color:srgb(0x8a8a84),roughness:0.35,metalness:0.8});
  const visor=new THREE.MeshStandardMaterial({color:srgb(0x0e1215),roughness:0.04,metalness:0.6,transparent:true,opacity:0.94});
  const tape=new THREE.MeshStandardMaterial({color:srgb(TEAM_COLORS[i%TEAM_COLORS.length]),roughness:0.45});
  const limb=(len,r0,rm,r1)=>lathe([[r1*0.7,-len],[r1,-len*0.94],[rm*1.05,-len*0.55],[rm,-len*0.3],[r0,-len*0.06],[r0*0.7,0]],12);
  const add=(parent,geo,mat,x,y,z)=>{ const ms=new THREE.Mesh(geo,mat); ms.position.set(x||0,y||0,z||0); parent.add(ms); return ms; };
  const hips=new THREE.Group(); hips.position.y=0.95; root.add(hips);
  add(hips,lathe([[0,-0.14],[0.17,-0.12],[0.21,-0.02],[0.22,0.08],[0,0.1]]),suit).scale.z=0.78;
  const spine=new THREE.Group(); spine.position.y=0.06; hips.add(spine);
  add(spine,lathe([[0.215,0],[0.25,0.12],[0.27,0.3],[0.265,0.45],[0.235,0.56],[0.15,0.63],[0.06,0.66],[0,0.665]],18),suit).scale.z=0.74;
  add(spine,new THREE.BoxGeometry(0.014,0.5,0.012),rubber,0,0.3,-0.198);                       // zipper
  add(spine,new THREE.CylinderGeometry(0.075,0.075,0.46,16),metal,0,0.33,0.24);                // air tank
  add(spine,new THREE.SphereGeometry(0.075,14,8,0,Math.PI*2,0,Math.PI/2),metal,0,0.56,0.24);
  add(spine,new THREE.CylinderGeometry(0.02,0.022,0.08,8),rubber,0,0.62,0.24);
  for(const y of [0.2,0.45]) add(spine,new THREE.BoxGeometry(0.5,0.035,0.07),rubber,0,y,0.19);  // straps
  const hose=add(spine,new THREE.TorusGeometry(0.14,0.014,6,16,Math.PI*0.9),rubber,0.12,0.6,0.06); hose.rotation.set(0,Math.PI/2,0.4);
  // hood, visor, respirator
  const head=new THREE.Group(); head.position.y=0.62; spine.add(head);
  add(head,new THREE.SphereGeometry(0.175,22,16),suit,0,0.12,0).scale.set(1,1.13,1.05);
  add(head,new THREE.SphereGeometry(0.18,24,14,Math.PI*1.5-0.85,1.7,1.0,0.85),visor,0,0.12,0).scale.set(1.04,1.16,1.09);
  const resp=new THREE.Group(); resp.position.set(0,0.035,-0.178); head.add(resp);
  add(resp,new THREE.CylinderGeometry(0.048,0.06,0.07,16),rubber).rotation.x=Math.PI/2;
  add(resp,new THREE.CylinderGeometry(0.03,0.03,0.02,12),metal,0,0,-0.04).rotation.x=Math.PI/2;
  for(const sx of [-1,1]){ const f=add(resp,new THREE.CylinderGeometry(0.038,0.038,0.05,16),metal,sx*0.07,-0.028,0.005);
    f.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(sx*0.72,-0.25,-0.65).normalize()); }
  // arms
  const arms=[-1,1].map(sx=>{ const sh=new THREE.Group(); sh.position.set(sx*0.27,0.53,0); spine.add(sh);
    add(sh,new THREE.SphereGeometry(0.1,14,10),suit);
    add(sh,limb(0.33,0.095,0.1,0.08),suit);
    add(sh,new THREE.CylinderGeometry(0.099,0.097,0.06,16),tape,0,-0.12,0);
    const el=new THREE.Group(); el.position.y=-0.33; sh.add(el);
    add(el,limb(0.3,0.08,0.083,0.065),suit);
    add(el,new THREE.CylinderGeometry(0.07,0.07,0.045,14),rubber,0,-0.27,0);
    add(el,new THREE.SphereGeometry(0.055,14,10),rubber,0,-0.34,0).scale.set(0.85,1.35,0.62);
    add(el,new THREE.SphereGeometry(0.022,8,6),rubber,-sx*0.045,-0.32,-0.03).scale.set(1,1.8,1);
    return {sh,el}; });
  // legs
  const legs=[-1,1].map(sx=>{ const hp=new THREE.Group(); hp.position.set(sx*0.11,-0.04,0); hips.add(hp);
    add(hp,limb(0.42,0.115,0.12,0.088),suit);
    const kn=new THREE.Group(); kn.position.y=-0.42; hp.add(kn);
    add(kn,limb(0.39,0.088,0.09,0.075),suit);
    add(kn,new THREE.CylinderGeometry(0.082,0.08,0.05,14),rubber,0,-0.33,0);
    const an=new THREE.Group(); an.position.y=-0.41; kn.add(an);
    add(an,new THREE.CylinderGeometry(0.075,0.08,0.13,14),rubber,0,0.03,0);
    add(an,new THREE.BoxGeometry(0.13,0.1,0.27),rubber,0,-0.03,-0.04);
    add(an,new THREE.BoxGeometry(0.14,0.03,0.29),rubber,0,-0.075,-0.04);
    return {hp,kn,an}; });
  root.userData={hips,spine,head,arms,legs,c:0,mv:0,suitMat:suit,visorMat:visor};
  return root;
}
function animateSuit(s,dt,t){
  const u=s.mesh.userData, crouch=s.mode==='crouch'||!!s.crouching;
  const v=(s.vel!==undefined)?s.vel:(s.moving?speedOf(s.mode):0);
  const w=clamp(v/2.2,0,1), run=clamp((v-3.2)/2.2,0,1);            // w: idle→walking blend, run: walking→sprint blend
  const R=1-Math.exp(-18*dt), Rs=1-Math.exp(-10*dt);
  u.c+=((crouch?1:0)-u.c)*(1-Math.exp(-8*dt)); const c=u.c, ph=s.stepPhase*Math.PI;
  const amp=(0.42+0.3*run)*w*(1-0.35*c);
  u.legs.forEach((L,i)=>{ const p=ph+(i?Math.PI:0), sn=Math.sin(p), lift=Math.max(0,Math.sin(p+1.25));
    const hip=sn*amp+c*1.1, knee=-lift*(0.75+0.6*run)*w-0.06*w-c*1.95;
    SM(L.hp.rotation,'x',hip,R); SM(L.kn.rotation,'x',knee,R); SM(L.an.rotation,'x',-(hip+knee)*0.85+Math.max(0,-sn)*0.18*w,R); });
  SM(u.hips.position,'y',0.95-c*0.38-0.015*w+Math.abs(Math.cos(ph))*(0.025+0.03*run)*w,R);   // body rises mid-stance
  SM(u.hips.rotation,'y',Math.sin(ph)*0.07*w,R);                                              // pelvis twist
  SM(u.spine.rotation,'y',-Math.sin(ph)*0.09*w,R);
  SM(u.spine.rotation,'z',-(s.lean||0)*0.32,R); SM(u.hips.rotation,'z',-(s.lean||0)*0.07,R);                                            // shoulders counter-twist
  SM(u.spine.rotation,'x',-(0.04+0.26*run)*w-c*0.42+Math.sin(t*1.5+(s.id||0))*0.012,Rs);      // lean into a sprint, breathe
  u.head.rotation.x=-u.spine.rotation.x*0.7; u.head.rotation.y=-(u.spine.rotation.y+u.hips.rotation.y)*0.8;   // head stays level
  u.arms.forEach((A,i)=>{ const p=ph+(i?0:Math.PI), sw=Math.sin(p)*amp*(0.7+0.5*run);
    SM(A.sh.rotation,'x',sw+c*0.45+0.15*run+Math.sin(t*1.1+i)*0.015,R);
    SM(A.sh.rotation,'z',(i?1:-1)*(0.09+0.04*w),Rs);
    SM(A.el.rotation,'x',0.22+0.22*w+0.9*run+Math.max(0,sw)*0.35+c*0.35,R); });
}

/* =====================================================================
   INTERACTION SYSTEM  (press E; anything can register an interactable)
   interactable = { pos:{x,z}, range, label(agent)->string|null, use(agent) }
   ===================================================================== */
function addInteractable(it){ G.interact.push(it); return it; }
function nearestInteractable(p){
  const fx=-Math.sin(p.yaw), fz=-Math.cos(p.yaw); let best=null, bd=1e9;
  for(const it of G.interact){
    const dx=it.pos.x-p.pos.x, dz=it.pos.z-p.pos.z, d=Math.hypot(dx,dz);
    if(d>it.range||d>=bd) continue;
    if(d>0.2&&(dx*fx+dz*fz)/d<0.35) continue;          // must roughly face it
    const label=it.label(p); if(!label) continue;
    best={it,label}; bd=d;
  }
  return best;
}
function tryInteract(){
  if(!G||G.over||G.paused||G.jump) return; const p=G.player; if(!p.alive) return;
  pushAction({a:'use'});
}
/** send an action to whoever runs the round: the local sim offline, the server online */
function pushAction(act){ if(!G||G.over) return; if(G.net) G.net.room.send('act',act); else G.player.actions.push(act); }

/* =====================================================================
   VENTS + SANITY + SMILERS
   ===================================================================== */
let SMILER_CANVAS=null, SMILER_TEX=null;
function smilerCanvas(){
  if(SMILER_CANVAS) return SMILER_CANVAS;
  const c=mkCanvas(256,256), g=c.getContext('2d');
  g.shadowColor='rgba(255,252,235,0.95)'; g.shadowBlur=22; g.fillStyle='#fffbea';
  for(const [ex,rot] of [[84,0.3],[172,-0.3]]){ g.beginPath(); g.ellipse(ex,88,17,8,rot,0,Math.PI*2); g.fill(); }
  g.beginPath(); g.moveTo(30,126); g.quadraticCurveTo(128,262,226,126); g.quadraticCurveTo(128,186,30,126); g.fill();
  g.shadowBlur=0; g.globalCompositeOperation='destination-out'; g.strokeStyle='#000';
  g.lineWidth=3; for(let i=1;i<16;i++){ const x=30+i*196/16; g.beginPath(); g.moveTo(x,120); g.lineTo(x,250); g.stroke(); }
  g.lineWidth=3.5; g.beginPath(); g.moveTo(40,134); g.quadraticCurveTo(128,214,216,134); g.stroke();
  g.globalCompositeOperation='source-over';
  for(const ex of [84,172]){ g.fillStyle='#000'; g.beginPath(); g.arc(ex,88,3.5,0,Math.PI*2); g.fill(); }
  SMILER_CANVAS=c; return c;
}
function makeVentMesh(){
  const g=new THREE.Group(), metal=new THREE.MeshStandardMaterial({color:srgb(0x7c786c),roughness:0.55,metalness:0.6});
  const W=0.8, Hh=0.5, y0=0.13;
  for(const [w,h,x,y] of [[W+0.05,0.05,0,y0+Hh],[W+0.05,0.05,0,y0],[0.05,Hh,-W/2,y0+Hh/2],[0.05,Hh,W/2,y0+Hh/2]]){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,0.035),metal); m.position.set(x,y,0); g.add(m); }
  const back=new THREE.Mesh(new THREE.PlaneGeometry(W-0.04,Hh-0.04),new THREE.MeshBasicMaterial({color:0x000000})); back.position.set(0,y0+Hh/2,-0.012); g.add(back);
  const hinge=new THREE.Group(); hinge.position.set(0,y0+Hh-0.02,0.012); g.add(hinge);
  for(let i=0;i<7;i++){ const s=new THREE.Mesh(new THREE.BoxGeometry(W-0.06,0.016,0.035),metal); s.position.set(0,-0.045-i*0.062,0); s.rotation.x=-0.55; hinge.add(s); }
  const gr=new THREE.Mesh(new THREE.PlaneGeometry(W*0.9,0.5),new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.18,depthWrite:false}));   // grime streak under it
  gr.position.set(0,y0-0.2,0.003); g.add(gr);
  g.userData={hinge}; return g;
}
function makeDuct(vent){
  const grp=new THREE.Group(); grp.position.set(vent.cam.x,0.36,vent.cam.z); grp.rotation.y=Math.atan2(vent.nx,vent.nz);
  const tg=new THREE.CylinderGeometry(0.42,0.42,7,4,1,true); tg.rotateY(Math.PI/4); tg.rotateX(Math.PI/2);
  const tube=new THREE.Mesh(tg,new THREE.MeshStandardMaterial({color:srgb(0x3a3934),roughness:0.45,metalness:0.7,side:THREE.BackSide})); tube.position.z=-3.55; grp.add(tube);
  for(let k=1;k<7;k++){ const rib=new THREE.Mesh(new THREE.TorusGeometry(0.4,0.012,4,4),tube.material); rib.rotation.z=Math.PI/4; rib.position.z=-k*0.95; grp.add(rib); }
  const end=new THREE.Mesh(new THREE.PlaneGeometry(0.7,0.7),new THREE.MeshBasicMaterial({color:0x000000})); end.position.z=-7; grp.add(end);
  if(!SMILER_TEX){ SMILER_TEX=new THREE.CanvasTexture(smilerCanvas()); SMILER_TEX.encoding=THREE.sRGBEncoding; }
  const smilers=[0,1,2].map(i=>{ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:SMILER_TEX,transparent:true,depthWrite:false,fog:false,color:HI()?new THREE.Color(2.5,2.5,2.3):new THREE.Color(1,1,1)}));
    sp.userData={off:i,x:(i-1)*0.18,y:(i%2?0.08:-0.05)}; sp.visible=false; grp.add(sp); return sp; });
  grp.userData={smilers}; return grp;
}
function updateSanity(dt){
  const p=G.player; if(p.isMonster||!p.alive) return;
  if(p.inVent){
    if(p.sanity>=CONFIG.ventWarn&&!p.warn1){ p.warn1=true; showMsg('something is in here with you',3); SFX.giggle(0.07); }
    if(p.sanity>=CONFIG.ventSmilers&&!p.warn2){ p.warn2=true; showMsg('GET OUT',2.5); SFX.giggle(0.2); }
  }
  if(p.sanity<CONFIG.ventWarn) p.warn1=false; if(p.sanity<CONFIG.ventSmilers) p.warn2=false;
  if(G.jump){ G.jump.t+=dt; if(G.jump.t>2.5) G.jump=null; }   // the sim ends it with a 'caught' event
}
function drawVentFX(dt,t,host){
  // grates swing open briefly when someone goes in or out
  for(const v of G.vents){ if(v.broken){ v.ripAnim+=dt; const hg=v.mesh.userData.hinge, q=clamp(v.ripAnim/0.55,0,1); hg.visible=true; hg.position.set(0.05*q,0.61*(1-q)+0.035*q,0.012+0.35*q); hg.rotation.set(-Math.PI/2*q-Math.sin(q*Math.PI)*0.8,0,q*0.35); continue; }
    v.openT=Math.max(0,v.openT-dt); v.open+=((v.openT>0?1:0)-v.open)*Math.min(1,dt*10); v.mesh.userData.hinge.rotation.x=-v.open*1.25; v.mesh.userData.hinge.visible=!(v.occupant&&v.occupant===host); }
  const p=G.player, ins=(host===p&&!p.isMonster)?clamp((p.sanity-10)/(CONFIG.ventDeath-10),0,1):0; G.insane=ins;
  // smilers creeping up the duct behind you
  if(G.duct){ const k=clamp((p.sanity-(CONFIG.ventWarn+1))/(CONFIG.ventDeath-CONFIG.ventWarn-1),0,1);
    G.duct.userData.smilers.forEach((sp,i)=>{ const on=p.sanity>=CONFIG.ventWarn+1+i*2.5; sp.visible=on;
      if(!on) return; const d=6.2-k*5.0+i*0.5; sp.position.set(sp.userData.x+Math.sin(t*0.7+i)*0.04,sp.userData.y,-d);
      sp.scale.setScalar(0.42); sp.material.opacity=(Math.random()<0.06?0.15:1)*(0.55+0.45*k); }); }
  $('hud').style.opacity=(G.jump||G.ejump)?0:1;
  // prompt
  const pr=$('prompt');
  if(!p.alive||p.isMonster&&!G.interact.length) pr.textContent='';
  else if(p.inVent) pr.textContent='[E] Leave vent';
  else { const n=nearestInteractable(p); pr.textContent=n?'[E] '+n.label:''; }
  // sanity meter
  const sv=p.isMonster?0:p.sanity/CONFIG.ventDeath; $('sanWrap').classList.toggle('hidden',sv<=0.001); $('san').style.width=((1-sv)*100)+'%';
  // whispers
  SFX.setWhisper(ins);
  // low-quality fallback distortion
  canvas.style.filter=(!HI()&&ins>0.01)?`saturate(${1-0.6*ins}) contrast(${1+0.35*ins}) blur(${(ins*1.4).toFixed(2)}px)`:'';
  // looking out through the grate from inside
  if(host.inVent&&!G.jump){ const W=ov.width,H=ov.height, fw=W*0.09, fh=H*0.13;
    ovg.fillStyle='rgba(8,7,4,0.97)'; ovg.fillRect(0,0,W,fh); ovg.fillRect(0,H-fh,W,fh); ovg.fillRect(0,0,fw,H); ovg.fillRect(W-fw,0,fw,H);
    const gap=(H-2*fh)/7; for(let i=0;i<7;i++){ const y=fh+i*gap, g=ovg.createLinearGradient(0,y,0,y+gap*0.55);
      g.addColorStop(0,'rgba(12,11,8,0.95)'); g.addColorStop(0.75,'rgba(40,38,30,0.85)'); g.addColorStop(1,'rgba(40,38,30,0)'); ovg.fillStyle=g; ovg.fillRect(fw,y,W-2*fw,gap*0.55); }
    const vg=ovg.createRadialGradient(W/2,H/2,H*0.2,W/2,H/2,W*0.6); vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.6)'); ovg.fillStyle=vg; ovg.fillRect(0,0,W,H); }
  // static + smiles at the edge of your vision
  if(ins>0.05){ const n=Math.floor(ins*500); for(let i=0;i<n;i++){ const c=Math.random()*255|0; ovg.fillStyle=`rgba(${c},${c},${c},${0.08+0.25*ins})`; ovg.fillRect(Math.random()*ov.width,Math.random()*ov.height,2+Math.random()*3,1+Math.random()*2); } }
  if(p.inVent&&p.sanity>=CONFIG.ventSmilers&&!G.jump){ const img=smilerCanvas();
    for(let i=0;i<3;i++){ if(Math.random()<0.5) continue; const sz=60+ins*80, side=i%2, x=side?ov.width-sz*0.6-Math.random()*40:-sz*0.4+Math.random()*40, y=ov.height*(0.2+0.25*i)+Math.random()*10;
      ovg.globalAlpha=0.15+0.5*ins*Math.random(); ovg.drawImage(img,x,y,sz,sz); } ovg.globalAlpha=1; }
  // jumpscare
  if(G.jump){ const j=G.jump.t, sz=Math.min(ov.width,ov.height)*(1.0+j*0.55), sh=12*(1+j*3);
    ovg.fillStyle=`rgba(0,0,0,${Math.min(1,0.6+j)})`; ovg.fillRect(0,0,ov.width,ov.height);
    ovg.drawImage(smilerCanvas(),ov.width/2-sz/2+(Math.random()-0.5)*sh,ov.height/2-sz/2+(Math.random()-0.5)*sh,sz,sz); }
}

/* =====================================================================
   ENTITY FIRST-PERSON ARMS (viewmodel attached to the camera)
   ===================================================================== */
function makeEntityViewArms(){
  const skin=new THREE.MeshPhysicalMaterial({map:TEX.skin.map,normalMap:TEX.skin.normal,normalScale:new THREE.Vector2(1.3,1.3),roughness:0.58,clearcoat:0.6,clearcoatRoughness:0.35});
  const bone=new THREE.MeshStandardMaterial({color:srgb(0x4b4234),roughness:0.5});
  const limbGeo=(len,r0,r1)=>{ r0*=1.4; r1*=1.4; const a=(r0+r1)/2; const g=lathe([[r0*0.55,0],[r0*1.25,len*0.05],[r0*0.95,len*0.14],[a*1.1,len*0.4],[a*1.25,len*0.6],[r1,len*0.86],[r1*1.15,len*0.94],[r1*0.6,len]],9); g.rotateX(Math.PI); return g; };
  const seg=(parent,len,r0,r1,mat)=>{ const pv=new THREE.Group(); const ms=new THREE.Mesh(limbGeo(len,r0,r1),mat||skin); ms.frustumCulled=false; pv.add(ms); const end=new THREE.Group(); end.position.y=-len; pv.add(end); parent.add(pv); return {pv,end}; };
  const root=new THREE.Group();
  const arms=[-1,1].map(sd=>{ const sh=new THREE.Group(); sh.position.set(sd*0.4,-0.3,0.12); root.add(sh);
    const up=seg(sh,0.62,0.05,0.032), fo=seg(up.end,0.56,0.032,0.024), wr=seg(fo.end,0.2,0.024,0.018);
    const knob=new THREE.Mesh(new THREE.SphereGeometry(0.05,8,6),skin); knob.frustumCulled=false; fo.pv.add(knob);
    const fingers=[]; for(let f=0;f<4;f++){ const a=seg(wr.end,0.2,0.012,0.008,bone); a.pv.rotation.set(0.25,0,(f-1.5)*0.32*sd); const b=seg(a.end,0.17,0.008,0.002,bone); b.pv.rotation.x=0.5; fingers.push({a,b}); }
    return {sh,up,fo,wr,fingers,sd}; });
  root.userData={arms,atk:null};
  return root;
}
function animateEntityViewArms(vm,m,dt,t){
  const u=vm.userData, w=clamp((m.vel||0)/3.4,0,1), burst=m.burstT>0, tired=m.cooldown>0;
  const R=1-Math.exp(-14*dt), Rh=1-Math.exp(-28*dt), ph=m.walkPhase;
  let atk=null; if(u.atk){ u.atk.t+=dt; const dur=u.atk.type==='bite'?0.3:u.atk.type==='rip'?0.95:0.42; if(u.atk.t>dur) u.atk=null; else atk={type:u.atk.type,side:u.atk.side,q:u.atk.t/dur}; }
  const aS=atk?Math.sin(atk.q*Math.PI):0, bite=atk&&atk.type==='bite'?aS:0, rip=(atk&&atk.type==='rip')?(atk.q<0.55?Math.sin(atk.q/0.55*Math.PI/2):1-(atk.q-0.55)/0.45*1.4):0, grab=atk&&atk.type==='rip'&&atk.q>0.45;
  // body motion: sway per stride, dip on each footfall, lunge forward on a bite
  SM(vm.position,'x',Math.sin(ph)*0.03*w,R);
  SM(vm.position,'y',-Math.abs(Math.sin(ph))*0.035*w-(tired?0.05:0)-bite*0.06,R);
  SM(vm.position,'z',-bite*0.2-rip*0.28,Rh);
  u.arms.forEach(A=>{ const sd=A.sd, sw=(atk&&atk.type==='swipe'&&atk.side===sd)?aS:0;
    SM(A.sh.rotation,'y',sw?sd*(0.75-atk.q*1.8):sd*(0.1+bite*0.4-rip*0.12),(sw||rip)?Rh:R);
    SM(A.up.pv.rotation,'x',1.42+Math.sin(t*1.1+sd)*0.025+Math.sin(ph+(sd>0?0:Math.PI))*0.1*w+(burst?0.3:0)-(tired?0.3:0)+sw*0.25-bite*0.25-rip*0.15,(sw||bite||rip)?Rh:R);
    SM(A.up.pv.rotation,'z',-sd*0.08-(sw?sd*0.15:0),R);
    SM(A.fo.pv.rotation,'x',0.12-(burst?0.15:0)+sw*0.15,R); SM(A.wr.pv.rotation,'x',0.35-sw*0.45,R);
    A.fingers.forEach((F,k)=>{ SM(F.a.pv.rotation,'x',0.25+Math.sin(t*(2.4+k*0.6)+sd)*0.08-sw*0.5-(burst?0.25:0)+(grab?0.8:0),R); SM(F.b.pv.rotation,'x',0.5+Math.sin(t*(3+k*0.8))*0.1-sw*0.3,R); }); });
}
/* Entity speed burst: short, very fast, long cooldown */

/* =====================================================================
   GAME STATE
   ===================================================================== */
let G=null; const keys={}; let locked=false, noLock=false, dragging=false;

const SET={net:SERVER_URL?'online':'offline',role:'random',size:16,seed:'',gfx:'high',anomaly:'random'};


const $=id=>document.getElementById(id);


function startGame(seed,lob){   // offline round from the local lobby (bots fill the other slots)
  lob=lob||LOBBY||{players:[{name:playerName(),you:true}].concat(rosterBotNames(seed,[playerName()]).map(n=>({name:n,bot:true})))};
  const present=lob.bots===false?lob.players.filter(q=>!q.bot):lob.players;   // AI off: only real players are in the round
  let ent=pickEntity(seed,present.length,-1);   // which person in the room plays the Entity: random, decided by the room seed
  if(lob.entity>=0){ const k=present.indexOf(lob.players[lob.entity]); if(k>=0) ent=k; }   // the host chose someone
  else if(lob.entity===undefined){   // no lobby (testing hooks): old role override
    if(SET.role==='monster') ent=0; else if(SET.role==='survivor'&&ent===0) ent=present.length>1?1+Math.floor(makeRng(seed+'#roles2')()*(present.length-1)):-1;   // -1: nobody is the Entity
  }
  const roster=present.map(q=>({name:q.name,human:!!q.you,pid:q.you?'me':null}));
  beginRound({seed,size:SET.size,anomalies:SET.anomaly!=='off',roster,entity:ent},'me',null);
}
/** build the round (identical on every machine for the same options), then the 3D scene around it */
function beginRound(opts,myPid,net){
  const W=createRound(opts);
  SET.gfx=PREF.gfx; setupRenderer();
  const world=buildScene(W.map), T=CONFIG.wallThick;
  for(const s of W.survivors){ s.mesh=makeSurvivorMesh(s.id); world.scene.add(s.mesh); }
  const monster=W.monster; monster.walkPhase=0; monster.mesh=makeEntityMesh(); world.scene.add(monster.mesh); if(monster.absent) monster.mesh.visible=false;
  for(const v of W.vents){ v.open=0; v.openT=0; v.mesh=makeVentMesh(); v.mesh.position.set(v.px+v.nx*(T/2+0.012),0,v.pz+v.nz*(T/2+0.012)); v.mesh.rotation.y=Math.atan2(v.nx,v.nz); world.scene.add(v.mesh); }
  const player=[monster,...W.survivors].find(a=>a.pid===myPid)||W.survivors[0]||monster;
  player.isPlayer=true;
  while(camera.children.length) camera.remove(camera.children[0]); world.scene.add(camera); camera.fov=PREF.fov; camera.updateProjectionMatrix();
  let vm=null; if(player.isMonster){ vm=makeEntityViewArms(); camera.add(vm); }
  G=Object.assign(W,world,{player,vm,net,interact:[],corpses:[],redK:0,darkK:0,redAnnounced:false,jump:null,duct:null,insane:0,paused:false,
     spectate:-1,camYaw:player.yaw,feed:[],msgT:0,beatT:0,poolT:0,flash:0,eye:player.isMonster?2.45:1.62,attackReq:false,noiseCues:[],stingCD:0,alerted:false,sendT:0});
  for(const v of W.vents) addInteractable({pos:v.face,range:1.5,
    label:a=>v.broken?null:a.isMonster?(G.monster.disguised?null:G.monster.ripCD>0?'Rip open vent ('+Math.ceil(G.monster.ripCD)+'s)':'Rip open vent'):(v.occupant||a.ventCD>0)?null:'Enter vent'});
  canvas.style.filter='';
  $('abilityPick').classList.toggle('hidden',!player.isMonster); if(player.isMonster) setTimeout(renderAbilityPick,0);
  $('role').textContent=player.isMonster?'You are the Entity':'You are a Survivor';
  const anomaly=W.anomaly;
  $('seedTag').textContent='seed: '+W.seed+(anomaly.name?'  ·  anomaly: '+anomaly.name.toLowerCase():'')+(net?'  ·  online':'');
  const an=$('anomaly'); if(anomaly.name){ $('anTitle').textContent=anomaly.name; $('anDesc').textContent=anomaly.desc; an.classList.remove('hidden'); an.style.opacity=1; const g0=G; setTimeout(()=>{ if(G===g0) an.style.opacity=0; },7000); } else an.classList.add('hidden');
  $('stamWrap').classList.toggle('hidden',player.isMonster);
  $('feed').innerHTML='';
  ['menu','end','pause','lobby'].forEach(id=>$(id).classList.add('hidden')); $('hud').classList.remove('hidden');
  SFX.init(); if(document.activeElement&&document.activeElement.blur) document.activeElement.blur(); lockPointer();
}

/* =====================================================================
   INPUT
   ===================================================================== */
// Browsers only lock the mouse right after a click, and rounds start from the lobby
// countdown. So from the first frame of a round the cursor is hidden and the mouse
// turns you without clicking ("free-look"); parking the cursor at the left/right edge
// keeps turning. Your first click upgrades that to a real lock (unlimited turning).
// If even a click-triggered lock is refused (embedded pages), free-look just stays on.
let lockByClick=false, mouseX=0.5, mouseIn=false;
function lockPointer(byClick){
  if(noLock||locked) return;
  lockByClick=!!byClick;
  try{ const r=canvas.requestPointerLock(); if(r&&r.catch) r.catch(()=>{ if(lockByClick) noLock=true; }); }catch(e){ if(lockByClick) noLock=true; }
}
document.addEventListener('pointerlockchange',()=>{ locked=document.pointerLockElement===canvas; if(!locked&&G&&!G.over&&!G.menuOpen) pauseGame(); });
document.addEventListener('pointerlockerror',()=>{ if(lockByClick) noLock=true; });
document.addEventListener('mousemove',e=>{
  mouseX=e.clientX/Math.max(1,innerWidth); mouseIn=true;
  if(!G||G.over||G.paused||G.menuOpen) return;
  const p=G.player, k=0.0022*PREF.sens; p.yaw-=e.movementX*k; p.pitch=clamp(p.pitch-e.movementY*k*(PREF.invert?-1:1),-1.35,1.35);
});
document.addEventListener('mouseleave',()=>{ mouseIn=false; });
/** free-look fallback: holding the cursor near the left/right edge keeps turning you */
function edgeTurn(dt){
  if(locked||!mouseIn||!G||G.over||G.paused||G.menuOpen) return;
  const E=0.08, d=mouseX<E?(E-mouseX)/E:mouseX>1-E?-(mouseX-(1-E))/E:0;
  if(d) G.player.yaw+=d*2.4*PREF.sens*dt;
}
function updateLookUI(){
  const inRound=!!(G&&!G.over&&!G.menuOpen);
  canvas.style.cursor=inRound?'none':'';
}
canvas.addEventListener('mousedown',e=>{
  if(VIEW){ dragging=true; return; }
  if(!G||G.over) return;
  if(!locked&&!noLock){ lockPointer(true); return; }
  dragging=true;
  if(G.player.isMonster) G.attackReq=e.button===2?'swipe':'bite'; else if(!G.player.alive) cycleSpectate();
});
addEventListener('mouseup',()=>{ dragging=false; });
canvas.addEventListener('contextmenu',e=>e.preventDefault());
addEventListener('keydown',e=>{ if(G&&G.menuOpen&&!G.over){ if(e.code==='Escape'&&noLock) resumeGame(); return; }   // menu open: no game input
  keys[e.code]=true; if(G&&!G.paused&&!G.player.alive&&!G.player.isMonster&&(e.code==='ArrowRight'||e.code==='ArrowLeft')){ e.preventDefault(); cycleSpectate(e.code==='ArrowRight'?1:-1); } if(e.code==='Space'&&G&&!G.paused) e.preventDefault(); if((e.code==='ShiftLeft'||e.code==='ShiftRight')&&!e.repeat&&G&&!G.over&&!G.paused&&G.player.isMonster) pushAction({a:'ability'}); if(e.code==='KeyE'&&!e.repeat) tryInteract(); if(G&&!G.paused&&G.player.isMonster&&!e.repeat){ if(G.monster.frozen){ if(e.code==='Digit1') chooseAbility(G.monster,'dash'); if(e.code==='Digit2') chooseAbility(G.monster,'mimic'); } else { if(e.code==='Digit1') G.attackReq='bite'; if(e.code==='Digit2') G.attackReq='swipe'; } } if(e.code==='Space'&&G&&!G.player.alive) cycleSpectate(); if(e.code==='Escape'&&G&&noLock&&!G.over){ if(G.menuOpen) resumeGame(); else pauseGame(); } });
addEventListener('keyup',e=>{ keys[e.code]=false; });
addEventListener('blur',()=>{ for(const k in keys) keys[k]=false; });
document.querySelectorAll('.opt[data-g]').forEach(b=>b.addEventListener('click',()=>{ document.querySelectorAll(`.opt[data-g="${b.dataset.g}"]`).forEach(o=>o.classList.remove('on')); b.classList.add('on'); SET[b.dataset.g]=(b.dataset.g==='time'||b.dataset.g==='size')?+b.dataset.v:b.dataset.v; }));
$('seedIn').addEventListener('input',e=>{ const v=e.target.value.replace(/\D/g,'').slice(0,9); if(v!==e.target.value) e.target.value=v; });   // numbers only
$('startBtn').addEventListener('click',()=>{ const s=$('seedIn').value.replace(/\D/g,'')||randomSeed(); $('menuNote').textContent=''; if(SET.net==='online') openOnlineLobby(s); else openLobby(s); });
$('againBtn').addEventListener('click',()=>{ const sd=G.seed; if(G.net){ leaveGame(true); showOnlineLobby(); } else { leaveGame(); openLobby(sd); } });
$('newBtn').addEventListener('click',()=>{ const online=!!G.net; leaveGame(); if(online) openOnlineLobby(randomSeed()); else openLobby(randomSeed()); });
$('menuBtn').addEventListener('click',leaveGame);

/* =====================================================================
   ONLINE: room lobby + round sync (the server runs the round)
   ===================================================================== */
let NET=null;   // {room, me}
function netLeave(){ if(NET){ const r=NET.room; NET=null; try{ r.leave(); }catch(e){} } }
function initModeButtons(){
  const on=$('modeOnline'); on.disabled=!SERVER_URL; on.title=SERVER_URL?'':'No game server is set up for this site yet';
  document.querySelectorAll('.opt[data-g="net"]').forEach(b=>b.classList.toggle('on',b.dataset.v===SET.net));
}
async function openOnlineLobby(code){
  if(document.activeElement&&document.activeElement.blur) document.activeElement.blur();
  netLeave(); clearInterval(lobbyTimer);
  PANELS.forEach(x=>$(x).classList.add('hidden')); $('end').classList.add('hidden'); $('lobby').classList.remove('hidden');
  $('lbRoom').textContent=code; $('lbInfo').innerHTML=''; $('lbList').innerHTML=''; $('lbEntLine').textContent=''; $('lbStatus').textContent='Connecting to the server…';
  LOBBY=null; SFX.init();
  let room;
  try{ room=await joinRoom(code,{name:playerName(),v:GAME_VERSION,size:SET.size,anomalies:SET.anomaly!=='off'}); }
  catch(e){ const msg=String(e&&e.message||e);
    $('lobby').classList.add('hidden'); $('menu').classList.remove('hidden');
    $('menuNote').textContent=/VERSION/.test(msg)?'The game was updated. Refresh the page to get the new version.':'Could not join room '+code+': '+msg.replace(/^.*?:\s*/,'');
    return; }
  NET={room,me:room.sessionId};
  room.onMessage('lobby',L=>{ if(!NET||NET.room!==room) return;
    const players=L.players.map(q=>({...q,joined:true,you:q.key===NET.me}));
    while(players.length<6) players.push({joined:false});
    LOBBY={online:true,seed:L.code,size:L.size,anomalies:L.anomalies,bots:L.bots,entity:L.entity,countdown:L.countdown,players};
    renderLobby(); });
  room.onMessage('start',opts=>{ if(!NET||NET.room!==room) return; clearInterval(lobbyTimer); beginRound(opts,NET.me,NET); });
  room.onMessage('s',S=>{ if(G&&G.net===NET) applySnapshot(S); });
  room.onMessage('ev',evs=>{ if(G&&G.net===NET) G.events.push(...evs); });
  room.onMessage('fix',f=>{ if(G&&G.net===NET){ G.player.pos.x=f.x; G.player.pos.z=f.z; } });
  room.onLeave(()=>{ if(!NET||NET.room!==room) return; NET=null;
    const inRound=G&&G.net&&!G.over; if(G&&G.net) leaveGame(true);
    if(inRound||!$('lobby').classList.contains('hidden')){ PANELS.forEach(x=>$(x).classList.add('hidden')); $('end').classList.add('hidden'); $('menu').classList.remove('hidden'); $('menuNote').textContent='Lost connection to the room.'; } });
  room.send('hello');   // handlers are ready: ask for the lobby
}
function showOnlineLobby(){
  if(!NET||!LOBBY){ $('menu').classList.remove('hidden'); return; }
  PANELS.forEach(x=>$(x).classList.add('hidden')); $('end').classList.add('hidden'); $('lobby').classList.remove('hidden'); renderLobby();
}
/** online: send your inputs, smooth everyone else toward the server's positions */
function netUpdate(dt){
  const p=G.player; G.sendT-=dt; if(G.sendT<=0){ G.sendT=0.05; G.net.room.send('input',p.input); }
  G.elapsed+=dt; G.timeLeft-=dt; for(const b of G.blackouts) b.t+=dt;
  const k=1-Math.exp(-14*dt);
  for(const a of [G.monster,...G.survivors]){ if(a===p||!a.net) continue; const n=a.net;
    if(Math.hypot(n.x-a.pos.x,n.z-a.pos.z)>4){ a.pos.x=n.x; a.pos.z=n.z; } else { a.pos.x+=(n.x-a.pos.x)*k; a.pos.z+=(n.z-a.pos.z)*k; }
    a.yaw+=angDiff(a.yaw,n.yaw)*k; }
}
function applySnapshot(S){
  const p=G.player; G.timeLeft=S.tl; G.elapsed=S.el;
  for(const r of S.s){ const a=agentById(G,r[0]); if(!a) continue;
    const [,x,z,yaw,pitch,mode,moving,cr,leanOff,alive,vent,st,ex,san,exT]=r;
    a.stamina=st; a.exhausted=!!ex; a.sanity=san; a.exhaustT=exT;
    const v=vent>=0?G.vents[vent]:null; if(a.inVent!==v){ if(a.inVent&&a.inVent.occupant===a) a.inVent.occupant=null; a.inVent=v; if(v) v.occupant=a; }
    if(a===p) continue;   // your own movement is predicted locally
    a.net={x,z,yaw}; if(!a.alive||a.inVent){ a.pos.x=x; a.pos.z=z; } a.pitch=pitch; a.mode=mode; a.moving=!!moving; a.crouching=!!cr; a.leanOff=leanOff; }
  const m=G.monster, M=S.m;
  for(const k of ['revealT','burstT','burstCD','mimicCD','biteCD','swipeCD','ripCD','ripT','cooldown','atkLock']) m[k]=M[k];
  m.frozen=!!M.frozen; m.ability=M.ability; m.seen=M.seen; m.state=M.state; if(M.look!=null) m.look=M.look;
  if(m!==p){ m.net={x:M.x,z:M.z,yaw:M.yaw}; m.pitch=M.pitch; m.mode=M.mode; m.moving=!!M.moving; m.crouching=!!M.crouching; }
  G.blackouts=S.b.map(([x,z,r,t,dur])=>({x,z,r,t,dur}));
}

/* =====================================================================
   SETTINGS + MENUS
   ===================================================================== */
const PREF=Object.assign({sens:1,invert:false,fov:74,vol:0.8,bob:1,gfx:'high',fps:false},(()=>{ try{ return JSON.parse(localStorage.getItem('level0hunt.settings')||'{}'); }catch(e){ return {}; } })());
SET.gfx=PREF.gfx;
function saveSettings(){ try{ localStorage.setItem('level0hunt.settings',JSON.stringify(PREF)); }catch(e){} }
function syncSettingsUI(){
  $('setSens').value=PREF.sens; $('vSens').textContent=(+PREF.sens).toFixed(2)+'x';
  $('setFov').value=PREF.fov; $('vFov').textContent=PREF.fov+'°';
  $('setVol').value=PREF.vol; $('vVol').textContent=Math.round(PREF.vol*100)+'%';
  $('setBob').value=PREF.bob; $('vBob').textContent=Math.round(PREF.bob*100)+'%';
  for(const [id,on] of [['setInvert',PREF.invert],['setFps',PREF.fps]]){ $(id).textContent=on?'On':'Off'; $(id).classList.toggle('on',on); }
  document.querySelectorAll('[data-gfx]').forEach(b=>b.classList.toggle('on',b.dataset.gfx===PREF.gfx));
  $('gfxNote').classList.toggle('hidden',!(G&&PREF.gfx!==SET.gfx));
  $('fps').classList.toggle('hidden',!PREF.fps);
}
function applyFov(){ if(G&&!G.ejump){ camera.fov=PREF.fov; camera.updateProjectionMatrix(); } }
$('setSens').addEventListener('input',e=>{ PREF.sens=+e.target.value; saveSettings(); syncSettingsUI(); });
$('setFov').addEventListener('input',e=>{ PREF.fov=+e.target.value; saveSettings(); syncSettingsUI(); applyFov(); });
$('setVol').addEventListener('input',e=>{ PREF.vol=+e.target.value; if(SFX.master) SFX.master.gain.value=PREF.vol; saveSettings(); syncSettingsUI(); });
$('setBob').addEventListener('input',e=>{ PREF.bob=+e.target.value; saveSettings(); syncSettingsUI(); });
$('setInvert').addEventListener('click',()=>{ PREF.invert=!PREF.invert; saveSettings(); syncSettingsUI(); });
$('setFps').addEventListener('click',()=>{ PREF.fps=!PREF.fps; saveSettings(); syncSettingsUI(); });
document.querySelectorAll('[data-gfx]').forEach(b=>b.addEventListener('click',()=>{ PREF.gfx=b.dataset.gfx; if(!G) SET.gfx=PREF.gfx; saveSettings(); syncSettingsUI(); }));

let panelReturn='menu';
const PANELS=['menu','pause','settingsPanel','controlsPanel','lobby'];
function openPanel(id,from){ panelReturn=from; PANELS.forEach(x=>$(x).classList.add('hidden')); $(id).classList.remove('hidden'); syncSettingsUI(); }
document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openPanel(b.dataset.open,b.closest('#pause')?'pause':'menu')));
document.querySelectorAll('.back').forEach(b=>b.addEventListener('click',()=>{ $('settingsPanel').classList.add('hidden'); $('controlsPanel').classList.add('hidden'); $(panelReturn).classList.remove('hidden'); }));
function resumeGame(){ if(!G) return; if(document.activeElement&&document.activeElement.blur) document.activeElement.blur(); PANELS.forEach(x=>$(x).classList.add('hidden')); G.menuOpen=false; G.paused=false; SFX.init(); lockPointer(true); }
function pauseGame(){ if(!G||G.over) return; G.menuOpen=true; for(const k in keys) keys[k]=false; G.attackReq=null; $('pause').classList.remove('hidden'); }   // the round keeps running, like online
function leaveGame(keepRoom){
  if(document.pointerLockElement) document.exitPointerLock();
  if(G&&G.net&&!keepRoom) netLeave();
  G=null; if(SFX.wh) SFX.setWhisper(0);
  canvas.style.filter=''; ovg.clearRect(0,0,ov.width,ov.height);
  $('vignette').style.opacity=0; $('flash').style.opacity=0; $('flash').style.background='#000';
  ['hud','end','settingsPanel','controlsPanel','pause','anomaly','abilityPick'].forEach(x=>$(x).classList.add('hidden')); $('menu').classList.remove('hidden');
  SET.gfx=PREF.gfx;
}

/* =====================================================================
   USERNAME + ROOM LOBBY (6 slots; bots fill empty ones)
   ===================================================================== */
function playerName(){ return (PREF.name||'').trim()||'Wanderer'; }
$('nameIn').value=PREF.name||'';
$('nameIn').addEventListener('input',e=>{ PREF.name=e.target.value.replace(/[<>]/g,'').slice(0,16); saveSettings(); });
let LOBBY=null, lobbyTimer=null;
function openLobby(seed){
  if(document.activeElement&&document.activeElement.blur) document.activeElement.blur();
  const names=rosterBotNames(seed,[playerName()]);
  LOBBY={seed,t:0,countdown:-1,bots:PREF.bots!==false,entity:-1,players:[{name:playerName(),you:true,host:true,joined:true,ready:false}].concat(names.map((n,i)=>{ const j=0.5+i*0.55+Math.random()*0.6; return {name:n,bot:true,joinAt:j,readyAt:j+0.8+Math.random()*2.2,joined:false,ready:false}; }))};
  PANELS.forEach(x=>$(x).classList.add('hidden')); $('end').classList.add('hidden'); $('lobby').classList.remove('hidden');
  $('lbRoom').textContent=seed;
  $('lbInfo').innerHTML=`${({12:'Small',16:'Medium',20:'Large'})[SET.size]} map · ${fmt(ROUND_TIME[SET.size])}<br>Anomalies: ${SET.anomaly==='off'?'off':'random'}`;
  clearInterval(lobbyTimer); let last=performance.now();
  lobbyTimer=setInterval(()=>{ const now=performance.now(); lobbyTick((now-last)/1000); last=now; },100);
  renderLobby(); SFX.init();
}
function lobbyTick(dt){
  const L=LOBBY; if(!L) return; L.t+=dt;
  for(const q of L.players) if(q.bot&&L.bots){ if(!q.joined&&L.t>=q.joinAt) q.joined=true; if(q.joined&&!q.ready&&L.t>=q.readyAt) q.ready=true; }
  const inRoom=L.players.filter(q=>!q.bot||L.bots), all=inRoom.every(q=>q.joined&&q.ready);
  if(all&&L.countdown<0) L.countdown=3;
  if(!all) L.countdown=-1;
  if(L.countdown>=0){ L.countdown-=dt; if(L.countdown<=0){ clearInterval(lobbyTimer); const lb=L; $('lobby').classList.add('hidden'); startGame(lb.seed,lb); LOBBY=null; return; } }
  renderLobby();
}
function renderLobby(){
  const L=LOBBY; if(!L) return;
  if(L.online) $('lbInfo').innerHTML=`${({12:'Small',16:'Medium',20:'Large'})[L.size]} map · ${fmt(ROUND_TIME[L.size])}<br>Anomalies: ${L.anomalies?'random':'off'}<br>Online room`;
  $('botsOn').classList.toggle('on',L.bots); $('botsOff').classList.toggle('on',!L.bots);
  $('lbList').innerHTML=L.players.map((q,i)=>(!q.joined||(q.bot&&!L.bots))?`<div class="lbRow empty"><span class="slot">${i+1}</span><span class="n">${L.bots?'waiting for player…':'empty slot'}</span></div>`
    :`<div class="lbRow${q.ready?' ready':''}${q.you?' you':''}"><span class="slot">${i+1}</span><span class="n">${q.name.replace(/[<>&]/g,'')}</span>${i===L.entity?'<span class="tag ent">ENTITY</span>':''}${q.host?'<span class="tag">HOST</span>':''}${q.you?'<span class="tag">YOU</span>':q.bot?'<span class="tag">BOT</span>':''}<span class="st">${q.ready?'✓ READY':'not ready'}</span></div>`).join('');
  const you=L.players.find(q=>q.you)||L.players[0], inRoom=L.players.filter(q=>!q.bot||L.bots), joined=inRoom.filter(q=>q.joined).length, ready=inRoom.filter(q=>q.ready).length;
  $('readyBtn').textContent=you.ready?'CANCEL READY':'READY';
  // Entity choice: everyone sees what the host picked
  const host=L.players.find(q=>q.host), hn=esc(host.name), isHost=you.host;
  const ent=L.entity>=0?L.players[L.entity]:null;
  $('lbEntLine').innerHTML=ent?`Entity: <b>${esc(ent.name)}${ent.you?' (you)':''}</b> · chosen by ${host.you?'you':hn} (host)`:`Entity: <b>random</b> · picked when the round starts · set by ${host.you?'you':hn} (host)`;
  const opts=[`<option value="-1">Random</option>`].concat(L.players.map((q,i)=>(q.joined&&(!q.bot||L.bots))?`<option value="${i}">${esc(q.name)}${q.you?' (you)':''}</option>`:'')).join('');
  const sel=$('entityPick'); if(sel.dataset.o!==opts){ sel.innerHTML=opts; sel.dataset.o=opts; } sel.value=String(L.entity); sel.disabled=!isHost; $('botsOn').disabled=$('botsOff').disabled=!isHost;
  $('entityPick').previousElementSibling.textContent=isHost?'Host: choose the Entity':'Only the host can change this';
  $('lbStatus').textContent=L.countdown>=0?`Everyone's ready. Starting in ${Math.ceil(L.countdown)}…`:`${joined}/6 in room · ${ready}/${joined} ready`+(!L.bots&&joined<2?' · AI off: no one to play against':'');
}
const esc=t=>String(t).replace(/[<>&"]/g,'');
function setEntity(i){
  const L=LOBBY; if(!L||!(L.players.find(q=>q.you)||{}).host||L.entity===i) return;
  if(L.online){ NET.room.send('entity',i>=0?L.players[i].key:'random'); return; }
  L.entity=i;
  // the teams changed, so everyone has to ready up again (no switching it on people mid-countdown)
  L.countdown=-1; for(const q of L.players){ q.ready=false; if(q.bot) q.readyAt=L.t+0.8+Math.random()*1.6; }
  renderLobby();
}
$('entityPick').addEventListener('change',e=>setEntity(+e.target.value));
function setBots(on){ if(!LOBBY||!(LOBBY.players.find(q=>q.you)||{}).host) return; if(LOBBY.online){ NET.room.send('bots',on); return; } LOBBY.bots=on; if(!on&&LOBBY.entity>=0&&LOBBY.players[LOBBY.entity].bot) LOBBY.entity=-1; PREF.bots=on; saveSettings(); if(on){ LOBBY.players.forEach(q=>{ if(q.bot){ q.joined=false; q.ready=false; q.joinAt=LOBBY.t+0.3+Math.random()*1.2; q.readyAt=q.joinAt+0.8+Math.random()*1.8; } }); } renderLobby(); }
$('botsOn').addEventListener('click',()=>setBots(true)); $('botsOff').addEventListener('click',()=>setBots(false));
$('readyBtn').addEventListener('click',()=>{ if(!LOBBY) return; const you=LOBBY.players.find(q=>q.you); if(LOBBY.online){ if(you) NET.room.send('ready',!you.ready); return; } you.ready=!you.ready; renderLobby(); });
$('lobbyLeave').addEventListener('click',()=>{ clearInterval(lobbyTimer); netLeave(); LOBBY=null; $('lobby').classList.add('hidden'); $('menu').classList.remove('hidden'); });

$('resumeBtn').addEventListener('click',resumeGame);
$('leaveBtn').addEventListener('click',leaveGame);
syncSettingsUI(); initModeButtons();


/* =====================================================================
   SHARED MOVEMENT HELPERS
   ===================================================================== */

/* =====================================================================
   PLAYER CONTROLLER  (client/player.ts)
   ===================================================================== */
function updatePlayer(dt){
  const p=G.player; if(!p.alive||p.inVent){ p.moving=false; p.mode='idle'; p.lean=0; p.leanOff=0; p.crouching=false; return; }
  let ix=0, iz=0; if(keys.KeyW||keys.ArrowUp)iz+=1; if(keys.KeyS||keys.ArrowDown)iz-=1; if(keys.KeyD||keys.ArrowRight)ix+=1; if(keys.KeyA||keys.ArrowLeft)ix-=1;
  const leaning=!p.isMonster&&!!keys.Space; let lt=0; if(leaning){ if(keys.KeyA) lt-=1; if(keys.KeyD) lt+=1; ix=0; }   // survivors: Space + A/D leans instead of strafing
  p.crouching=!!keys.KeyC;
  const moving=!!(ix||iz);
  const fx=-Math.sin(p.yaw), fz=-Math.cos(p.yaw), rx=Math.cos(p.yaw), rz=-Math.sin(p.yaw);
  let dx=fx*iz+rx*ix, dz=fz*iz+rz*ix; const l=Math.hypot(dx,dz); if(l){ dx/=l; dz/=l; }
  let speed;
  if(p.isMonster){ speed=(G.monster.frozen||G.jump)?0:entitySpeed(p)*(p.crouching?CONFIG.entityCrouchSpeed:1); p.mode=!(moving&&speed)?'idle':p.crouching?'crouch':'walk'; }
  else {
    const crouch=!!keys.KeyC, wantSprint=!!(keys.ShiftLeft||keys.ShiftRight);
    p.mode=!moving?'idle':crouch?'crouch':(wantSprint&&!p.exhausted&&p.stamina>0)?'sprint':'walk';
    speed=G.jump?0:speedOf(p.mode);
  }
  p.pos.x+=dx*speed*dt; p.pos.z+=dz*speed*dt; collide(p.pos,p.radius);
  p.moving=moving&&speed>0;
  // lean: smooth in/out, stop short of walls so you can't see through them
  p.lean=(p.lean||0)+(lt-(p.lean||0))*(1-Math.exp(-10*dt));
  const lmax=p.isMonster?CONFIG.leanEntity:CONFIG.leanSurvivor, sg=Math.sign(p.lean); let room=0;
  if(Math.abs(p.lean)>0.01) for(let k=0.05;k<=lmax+1e-6;k+=0.05){ if(pointBlocked(p.pos.x+rx*k*sg,p.pos.z+rz*k*sg,0.14)) break; room=k; }
  p.leanOff=sg*Math.min(Math.abs(p.lean)*lmax,room);
  p.headPos={x:p.pos.x+rx*p.leanOff,z:p.pos.z+rz*p.leanOff};
}

/* =====================================================================
   BOT SURVIVOR AI  (stand-in for the 3 other human players)
   ===================================================================== */

/* =====================================================================
   MONSTER AI  (server/monster.ts once networked; here it's the bot)
   ===================================================================== */

/* =====================================================================
   BODIES: left behind where the Entity catches someone; black parasites
   slowly overrun them (fully covered after CONFIG.corruptTime seconds)
   ===================================================================== */
let POOL_TEX=null, LUMP_GEO=null;
function makeCorpse(s){
  const mesh=s.mesh, u=mesh.userData, r=makeRng(G.seed+'#body'+s.id), born=G.elapsed;
  mesh.visible=true; mesh.rotation.order='YXZ';
  let yaw=r()*Math.PI*2, bestClear=-1;
  for(let k=0;k<16;k++){ const yw=r()*Math.PI*2, dx=-Math.sin(yw), dz=-Math.cos(yw); let clear=0;
    for(const t of [-0.95,-0.5,0.5,0.95]) if(!pointBlocked(s.pos.x+dx*t,s.pos.z+dz*t,0.28)) clear++;
    if(clear>bestClear){ bestClear=clear; yaw=yw; } if(clear===4) break; }
  mesh.position.set(s.pos.x,0.17,s.pos.z); mesh.rotation.set(-Math.PI/2+(r()-0.5)*0.15,yaw,(r()-0.5)*0.3);
  // mangled pose: limbs bent the wrong way, neck twisted
  u.hips.position.y=0.95; u.hips.rotation.set(0,0,(r()-0.5)*0.4);
  // (face-down: bending toward the back lifts a limb off the floor, so every break bends that way)
  u.spine.rotation.set(0.05+r()*0.2,(r()-0.5)*0.6,(r()-0.5)*0.7);
  u.head.rotation.set(-0.2-r()*0.3,(r()<0.5?-1:1)*(0.9+r()*0.6),0.3+r()*0.4);
  u.arms.forEach((A,i)=>{ A.sh.rotation.set(-0.3-r()*2.2,(r()-0.5)*0.8,(i?1:-1)*(0.4+r()*1.3)); A.el.rotation.set(-(0.7+r()*1.4),0,(r()-0.5)*0.6); });
  u.legs.forEach((L,i)=>{ L.hp.rotation.set(-r()*0.6,(r()-0.5)*0.5,(i?1:-1)*(0.15+r()*0.6)); L.kn.rotation.set(-(0.4+r()*1.5),0,(r()-0.5)*0.8); L.an.rotation.set((r()-0.5)*0.8,0,0); });
  if(u.visorMat){ u.visorMat.opacity=0.55; u.visorMat.color.copy(srgb(0x2a2f33)); }   // cracked, fogged visor
  // torn suit / wounds
  const wound=new THREE.MeshStandardMaterial({color:srgb(0x3b0707),roughness:0.25});
  [u.spine,u.arms[0].el,u.legs[1].kn,u.hips].forEach(par=>{ const w=new THREE.Mesh(new THREE.SphereGeometry(0.07,8,6),wound); w.scale.set(1.2,0.6,0.35); w.position.set((r()-0.5)*0.1,par===u.spine?0.3:-0.12,-0.2); par.add(w); });
  // stain under the body
  if(!POOL_TEX){ const c=mkCanvas(256,256), g=c.getContext('2d'); for(let i=0;i<9;i++) blob(g,128+(Math.random()-0.5)*90,128+(Math.random()-0.5)*90,45+Math.random()*50,'rgba(255,255,255,A)',0.9); POOL_TEX=new THREE.CanvasTexture(c); }
  const poolMat=new THREE.MeshStandardMaterial({color:srgb(0x3d0505),roughness:0.38,transparent:true,alphaMap:POOL_TEX,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-4});
  const pool=new THREE.Mesh(new THREE.PlaneGeometry(1,1),poolMat); pool.rotation.x=-Math.PI/2; pool.position.set(s.pos.x,0.009,s.pos.z); pool.scale.setScalar(0.2); G.scene.add(pool);
  // center the body on the spot where they fell
  mesh.updateMatrixWorld(true); const hp=u.spine.getWorldPosition(new THREE.Vector3()); mesh.position.x+=s.pos.x-hp.x; mesh.position.z+=s.pos.z-hp.z;
  mesh.updateMatrixWorld(true); const bb=new THREE.Box3().setFromObject(mesh); mesh.position.y+=0.01-bb.min.y;   // nothing sinks into the floor
  // sample points over the body surface for parasites to grow on
  mesh.updateMatrixWorld(true);
  // sample real points on the body's surface (so the growth hugs the suit, not the air around it)
  const parts=[]; mesh.traverse(o=>{ if(o.isMesh&&o.geometry&&o.geometry.attributes.position&&o.material!==u.visorMat) parts.push(o); });
  const _v=new THREE.Vector3(), _n=new THREE.Vector3(), _nm=new THREE.Matrix3();
  const surf=()=>{ const o=parts[Math.floor(r()*parts.length)], pa=o.geometry.attributes.position, na=o.geometry.attributes.normal, i=Math.floor(r()*pa.count);
    _v.fromBufferAttribute(pa,i).applyMatrix4(o.matrixWorld); if(na){ _nm.getNormalMatrix(o.matrixWorld); _n.fromBufferAttribute(na,i).applyMatrix3(_nm).normalize(); _v.addScaledVector(_n,0.012); } return _v.clone(); };
  const BN=170, WN=60, FN=40;
  const blobs=[], worms=[], floor=[];
  for(let i=0;i<BN;i++){ const p=surf(); p.y=Math.max(0.03,p.y); blobs.push({p,s:(0.025+r()*0.055)*(i>BN*0.6?1.5:1),a:Math.pow(i/BN,0.85)*CONFIG.corruptTime*0.92+r()*6,ph:r()*6}); }
  for(let i=0;i<WN;i++){ const p=surf(); p.y=Math.max(0.03,p.y); const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(r()*6,r()*6,r()*6)); worms.push({p,q,l:0.08+r()*0.14,a:10+Math.pow(i/WN,0.9)*CONFIG.corruptTime*0.9,ph:r()*6}); }
  for(let i=0;i<FN;i++){ const ang=r()*Math.PI*2, d=0.35+Math.pow(r(),0.7)*1.4; floor.push({p:new THREE.Vector3(s.pos.x+Math.cos(ang)*d,0.012,s.pos.z+Math.sin(ang)*d),ang,len:0.15+r()*0.35,a:CONFIG.corruptTime*(0.3+0.7*(d/1.8))+r()*8,ph:r()*6}); }
  const pmat=new THREE.MeshPhysicalMaterial({color:srgb(0x0a0607),roughness:0.55,metalness:0,clearcoat:0.5,clearcoatRoughness:0.45});
  if(!LUMP_GEO){ LUMP_GEO=new THREE.IcosahedronGeometry(1,1); const pa=LUMP_GEO.attributes.position; for(let i=0;i<pa.count;i++){ const f=0.75+Math.abs(Math.sin(pa.getX(i)*7.3+pa.getY(i)*4.1)*Math.cos(pa.getZ(i)*5.7))*0.5; pa.setXYZ(i,pa.getX(i)*f,pa.getY(i)*f*0.7,pa.getZ(i)*f); } LUMP_GEO.computeVertexNormals(); }
  const bm=new THREE.InstancedMesh(LUMP_GEO,pmat,BN), wg=new THREE.CylinderGeometry(0.5,0.25,1,6); wg.translate(0,0.5,0);
  const wm=new THREE.InstancedMesh(wg,pmat,WN), fm=new THREE.InstancedMesh(new THREE.SphereGeometry(1,7,5),pmat,FN);
  [bm,wm,fm].forEach(im=>{ im.frustumCulled=false; G.scene.add(im); });
  const c={s,mesh,born,pool,poolMat,suitMat:u.suitMat,blobs,worms,floor,bm,wm,fm,sqT:4+r()*6};
  G.corpses.push(c); updateCorpse(c,0,G.elapsed); return c;
}
const _cm=new THREE.Matrix4(), _cq=new THREE.Quaternion(), _cs=new THREE.Vector3(), _cp=new THREE.Vector3(), _ce=new THREE.Euler();
function updateCorpse(c,dt,t){
  const age=t-c.born, k=clamp(age/CONFIG.corruptTime,0,1), grow=a=>{ const x=clamp((age-a)/8,0,1); return x*x*(3-2*x); };
  // stain spreads, then blackens; the suit slowly goes dark
  c.pool.scale.setScalar(0.3+Math.min(1,age/6)*1.1+k*0.9);
  c.poolMat.color.copy(srgb(0x3d0505)).lerp(srgb(0x050404),k);
  if(c.suitMat) c.suitMat.color.setRGB(1-0.94*k,1-0.95*k,1-0.96*k);
  c.blobs.forEach((b,i)=>{ const g=grow(b.a), pz=1+Math.sin(t*1.6+b.ph)*0.08; _cs.set(b.s*g*pz*1.2,b.s*g*pz*0.75,b.s*g*pz).addScalar(1e-4); _cq.setFromAxisAngle(_cp.set(Math.sin(b.ph),1,Math.cos(b.ph)).normalize(),b.ph); c.bm.setMatrixAt(i,_cm.compose(b.p,_cq,_cs)); });
  c.worms.forEach((w,i)=>{ const g=grow(w.a); _ce.set(Math.sin(t*2.3+w.ph)*0.5,Math.sin(t*1.7+w.ph)*0.6,0); _cq.setFromEuler(_ce).premultiply(w.q); _cs.set(0.022*g,w.l*g*(1+Math.sin(t*3+w.ph)*0.15),0.022*g); c.wm.setMatrixAt(i,_cm.compose(w.p,_cq,_cs)); });
  c.floor.forEach((f,i)=>{ const g=grow(f.a); _cq.setFromAxisAngle(_cp.set(0,1,0),-f.ang); _cs.set(f.len*g*0.5*(1+Math.sin(t+f.ph)*0.05),0.012*g,0.035*g); c.fm.setMatrixAt(i,_cm.compose(f.p,_cq,_cs)); });
  c.bm.instanceMatrix.needsUpdate=true; c.wm.instanceMatrix.needsUpdate=true; c.fm.instanceMatrix.needsUpdate=true;
  // faint wet noises once the parasites are thriving
  if(age>20&&dt>0){ c.sqT-=dt; if(c.sqT<=0){ c.sqT=3+Math.random()*7; const cam=camera.position; if(Math.hypot(cam.x-c.s.pos.x,cam.z-c.s.pos.z)<7) SFX.squelch(c.s.pos.x,c.s.pos.z,0.05+0.1*k,false); } }
}

/* =====================================================================
   VENT RIP (Entity, E at a vent): tears the grate off and throws the
   hider out, with a head start (the Entity is stuck and can't attack briefly)
   ===================================================================== */


/* =====================================================================
   ENTITY ABILITY CHOICE (during the freeze): DASH or MIMIC
   Mimic: looks, sounds and moves like a survivor (no sprint), no light
   flicker or heartbeat giveaway; unveil to attack; 15s before it can re-disguise
   ===================================================================== */
function chooseAbility(m,ab){ if(!m.frozen) return; pushAction({a:'pick',ab}); }
function renderAbilityPick(){ if(!G) return; const m=G.monster; document.querySelectorAll('#abilityPick .card').forEach(c=>c.classList.toggle('on',c.dataset.ab===m.ability)); }

/* =====================================================================
   ENTITY ATTACKS: [1] bite (short range, fast)  [2] arm swipe (longer reach, wide arc)
   ===================================================================== */

/* =====================================================================
   ROUND + WIN CONDITIONS  (server/round.ts)
   ===================================================================== */
function feed(t){ G.feed.unshift(t); G.feed=G.feed.slice(0,5); $('feed').innerHTML=G.feed.join('<br>'); }
function showMsg(t,dur){ $('msg').textContent=t; G.msgT=dur; }
function onCaught(e){
  const s=agentById(G,e.id); if(!s) return;
  if(G.net){ s.alive=false; s.pos={x:e.x,z:e.z}; s.inVent=null; }
  s.caughtAt=e.at+(e.cause==='smilers'?' (smilers)':''); s.mode=e.mode||s.mode;
  if(e.cause==='smilers') s.mesh.visible=false; else makeCorpse(s);
  feed(e.cause==='smilers'?`${esc(s.name)} lost their mind in the vents · ${e.at}`:`${esc(s.name)} was taken · ${e.at}`); if(e.cause!=='smilers') SFX.crunch();
  if(s===G.player&&G.duct){ G.scene.remove(G.duct); G.duct=null; }
  if(s===G.player&&e.cause!=='smilers'){ const m=G.monster; G.ejump={t:0,yaw0:s.yaw,yaw1:Math.atan2(-(m.pos.x-s.pos.x),-(m.pos.z-s.pos.z)),eye:s.mode==='crouch'?1.0:1.62}; SFX.entityScream();
    setTimeout(()=>{ if(G&&!G.over) cycleSpectate(); },2100); }
  else if(s===G.player){ G.jump=null; G.flash=1; showMsg('THE SMILERS GOT YOU',2.5); setTimeout(()=>{ if(G&&!G.over) cycleSpectate(); },1200); }
  else if(G.player.isMonster) showMsg('CAUGHT '+s.name.toUpperCase(),1.2);
}
function cycleSpectate(dir){ dir=dir||1;
  const alive=G.survivors.filter(s=>s.alive&&!s.isPlayer); if(!alive.length){ G.spectate=-1; return; }
  const idx=alive.findIndex(s=>s.id===G.spectate); const next=alive[((idx<0?(dir>0?-1:0):idx)+dir+alive.length)%alive.length]; G.spectate=next.id; G.camYaw=next.yaw;
}
function endRound(winner,time){
  G.over=true; if(document.pointerLockElement) document.exitPointerLock();
  const me=G.player, youWon=(winner==='monster')===me.isMonster;
  $('endTitle').textContent=winner==='monster'?'THE ENTITY WINS':'SURVIVORS MADE IT';
  $('endTitle').style.color=youWon?'#f0e2a0':'#c8553a';
  const lines=[`<span style="opacity:.6">Entity:</span> ${esc(G.monster.name)}${G.monster===me?' (you)':''}`].concat(G.survivors.map(s=>`${esc(s.name)}${s===me?' (you)':''}: ${s.alive?'survived':'taken at '+s.caughtAt}`));
  $('endBody').innerHTML=`${youWon?'You won.':'You lost.'} Time played ${time||fmt(CONFIG.roundTime-Math.max(0,G.timeLeft))}<br><br>${lines.join('<br>')}<br><br><span style="opacity:.55">seed: ${G.seed}${G.net?' · online':''}</span>`;
  $('againBtn').textContent=G.net?'BACK TO ROOM':'PLAY AGAIN';
  const g0=G; setTimeout(()=>{ if(G!==g0) return; ['pause','settingsPanel','controlsPanel'].forEach(x=>$(x).classList.add('hidden')); $('hud').classList.add('hidden'); $('end').classList.remove('hidden'); },G.ejump?2000:900);
}

/* =====================================================================
   SIM EVENTS -> sound, animation, HUD (same code offline and online)
   ===================================================================== */
function handleEvent(e){
  const p=G.player, m=G.monster, me=a=>a===p, X=a=>me(a)?null:a.pos.x;
  const a=e.id!=null?agentById(G,e.id):null, v=e.v!=null?G.vents[e.v]:null;
  switch(e.t){
    case 'unfreeze': if(me(m)){ $('abilityPick').classList.add('hidden'); showMsg((m.ability==='mimic'?'MIMIC':'DASH')+'  ·  [Shift]',1.6); } break;
    case 'ability': m.ability=e.ab; renderAbilityPick(); break;
    case 'burst': SFX.burst(X(m),m.pos.z); break;
    case 'disguise': { m.disguised=true; m.look=e.look; if(G.mimicMesh) G.scene.remove(G.mimicMesh);
      G.mimicMesh=makeSurvivorMesh(e.look); G.scene.add(G.mimicMesh); G.mimicAgent={mesh:G.mimicMesh,id:9,mode:'idle',moving:false,stepPhase:0,vel:0,lean:0,crouching:false};
      SFX.disguise(X(m),m.pos.z); break; }
    case 'reveal': m.disguised=false; G.alerted=!!(m.seen&&m.seen.includes(p.id)); SFX.reveal(X(m),m.pos.z); break;   // the unveil has its own sound, no extra sting
    case 'attack': m.atk={type:e.type,t:0,side:e.side}; if(me(m)&&G.vm) G.vm.userData.atk={type:e.type,t:0,side:e.side};
      if(e.type==='bite') SFX.bite(X(m),m.pos.z); else SFX.swipe(X(m),m.pos.z); break;
    case 'rip': v.broken=true; v.ripAnim=0; m.atk={type:'rip',t:0,side:1}; if(me(m)&&G.vm) G.vm.userData.atk={type:'rip',t:0,side:1};
      SFX.rip(me(m)?null:v.face.x,v.face.z); break;
    case 'ventIn': v.openT=0.7; if(G.net){ a.inVent=v; v.occupant=a; a.pos={...v.front}; a.yaw=v.yawOut; }
      if(me(a)){ a.pos={...v.front}; a.yaw=v.yawOut; a.pitch=-0.05; G.duct=makeDuct(v); G.scene.add(G.duct); showMsg('hiding in the vent',1.6); }
      SFX.clank(); break;
    case 'ventOut': v.openT=0.7; if(G.net){ a.inVent=null; if(v.occupant===a) v.occupant=null; }
      a.pos={x:e.x,z:e.z}; if(a.net) a.net={...a.net,x:e.x,z:e.z};
      if(me(a)){ a.yaw=v.yawOut; a.pitch=0; if(G.duct){ G.scene.remove(G.duct); G.duct=null; } }
      SFX.clank(); break;
    case 'eject': a.pos={x:e.x,z:e.z}; if(a.net) a.net={...a.net,x:e.x,z:e.z};
      if(me(a)){ showMsg('IT FOUND YOU. RUN.',2); G.flash=Math.max(G.flash,0.35); $('flash').style.background='#3a0000'; SFX.sting(); } break;
    case 'smilers': if(me(a)&&!G.jump){ G.jump={t:0,s:a}; SFX.scream(); } break;
    case 'caught': onCaught(e); break;
    case 'power': SFX.powerDown(e.x,e.z,false,!!e.back); break;
    case 'left': feed(`${esc(e.name)} disconnected · a bot took over`); if(a){ a.human=false; } break;
    case 'end': endRound(e.winner,e.time); break;
  }
}
function drainEvents(){ if(!G) return; const evs=G.events.splice(0); for(const e of evs){ handleEvent(e); if(!G) return; } }


/* =====================================================================
   ENTITY JUMPSCARE (plays when it catches you)
   ===================================================================== */
const _hw=new THREE.Vector3();
function runEntityJump(dt,t){
  const J=G.ejump, p=G.player, m=G.monster, mm=m.mesh, u=mm.userData; J.t+=dt; const k=J.t;
  if(k>1.3){ G.ejump=null; camera.fov=PREF.fov; camera.updateProjectionMatrix(); u.maw.visible=false; u.head.add(u.maw); u.maw.position.set(0,-0.02,-0.36); u.maw.rotation.set(0,0,0); u.maw.scale.setScalar(1); u.head.children.forEach(c=>{ if(c!==u.maw) c.visible=true; }); camera.fov=74; camera.updateProjectionMatrix(); mm.rotation.order='XYZ'; return; }
  // 1) your head gets yanked around to face it
  const turn=Math.min(1,k/0.12); p.yaw=J.yaw0+angDiff(J.yaw0,J.yaw1)*(1-Math.pow(1-turn,3)); p.pitch=0;
  const sh=k<1.02?(0.02+0.06*Math.min(1,k/0.5)):0;
  camera.position.set(p.pos.x+(Math.random()-0.5)*sh,J.eye+(Math.random()-0.5)*sh,p.pos.z+(Math.random()-0.5)*sh);
  camera.rotation.set(p.pitch+(Math.random()-0.5)*sh*0.6,p.yaw+(Math.random()-0.5)*sh*0.6,(Math.random()-0.5)*sh*1.5);
  camera.fov=PREF.fov-Math.min(1,k/0.55)*12; camera.updateProjectionMatrix();
  // 2) it lunges into your face: head pinned in front of the camera, jaw wide, arms reaching
  if(k<1.02){
    mm.visible=true; animateEntity({mesh:mm,state:'chase',moving:true,frozen:false,walkPhase:m.walkPhase+t*14,yaw:p.yaw+Math.PI,pos:m.pos},dt,t);
    mm.rotation.order='YXZ'; mm.rotation.set(-0.2,p.yaw+Math.PI,(Math.random()-0.5)*0.08);
        const ease=1-Math.pow(1-Math.min(1,Math.max(0,(k-0.08)/0.42)),3), dist=1.9-ease*1.45;
    u.jaw.rotation.x=-1.0-Math.random()*0.15; u.head.rotation.z=(Math.random()-0.5)*0.35; u.head.rotation.y=(Math.random()-0.5)*0.1; u.head.rotation.x=u.head.baseX-0.15;
    const open=Math.min(1,Math.max(0,(k-0.12)/0.3)); u.maw.visible=open>0; u.head.children.forEach(c=>{ if(c!==u.maw) c.visible=open<0.35; });
    u.petals.forEach((pv,i)=>{ pv.rotation.x=-(0.2+open*1.15)+Math.sin(t*40+i)*0.06; });
    if(!u.eyeMeshes) u.eyeMeshes=u.head.children.filter(c=>c.isMesh&&c.material.fog===false);
    mm.position.set(0,0,0); mm.updateMatrixWorld(true); _hw.set(0,0,0); const _e=new THREE.Vector3();
    u.eyeMeshes.forEach(e=>{ e.getWorldPosition(_e); _hw.add(_e); }); _hw.multiplyScalar(1/u.eyeMeshes.length);   // pin the face, not the skull
    const fx=-Math.sin(p.yaw), fz=-Math.cos(p.yaw);
    mm.position.set(p.pos.x+fx*dist-_hw.x, J.eye-0.02-_hw.y, p.pos.z+fz*dist-_hw.z);
    // the split mouth is pinned facing the camera so it always reads head-on
    if(u.maw.parent!==G.scene) G.scene.add(u.maw);
    u.maw.position.set(p.pos.x+fx*(dist-0.04),J.eye-0.05,p.pos.z+fz*(dist-0.04)); u.maw.rotation.set(0,0,0); u.maw.lookAt(camera.position); u.maw.rotateY(Math.PI);
    u.maw.rotateZ(Math.sin(t*23)*0.05); u.maw.scale.setScalar((0.5+open*0.6)*1.55);
    $('flash').style.background='#5a0000'; G.flash=Math.max(G.flash,k<0.15?0.35:0);
  } else { mm.visible=false; u.maw.visible=false; $('flash').style.background='#000'; G.flash=1; if(!J.msg){ J.msg=true; showMsg('YOU WERE TAKEN',2.5); } }   // 3) hard cut to black
}


/* =====================================================================
   RED FINAL SECONDS + REGIONAL BLACKOUTS
   ===================================================================== */
const TINT_WARM=new THREE.Color(1,0.95,0.85), TINT_RED=new THREE.Color(1,0.12,0.08), _tint=new THREE.Color();
const LIGHT_WARM=srgb(0xfff0cf), LIGHT_RED=srgb(0xff2a18), HEMI_SKY=srgb(0xe8d39a), HEMI_GND=srgb(0x4d4120), HEMI_RSKY=srgb(0xb0302a), HEMI_RGND=srgb(0x3a0d0a), FOG_RED=srgb(0x2a0806);
   // fully out (after the warning flicker)
function updateAtmosphere(dt,cam){
  const red=G.timeLeft<=CONFIG.redTime?1:0;
  G.redK+=(red-G.redK)*(1-Math.exp(-1.2*dt));
  if(red&&!G.redAnnounced&&!G.over){ G.redAnnounced=true; showMsg(CONFIG.redTime+' SECONDS',2.5); SFX.powerDown(null,null,true); }
  const inD=isDark(cam)?1:0; G.darkK+=(inD-G.darkK)*(1-Math.exp(-3*dt));
  const r=G.redK; _tint.copy(TINT_WARM).lerp(TINT_RED,r);
  G.pool.forEach(pl=>pl.color.copy(LIGHT_WARM).lerp(LIGHT_RED,r));
  G.hemi.color.copy(HEMI_SKY).lerp(HEMI_RSKY,r); G.hemi.groundColor.copy(HEMI_GND).lerp(HEMI_RGND,r);
  G.hemi.intensity=0.3*(1-0.9*G.darkK)*(1-0.2*r);
  G.scene.fog.color.copy(FOG).lerp(FOG_RED,r).multiplyScalar(1-0.85*G.darkK); G.scene.background.copy(G.scene.fog.color);
  if(G.fogBase===undefined) G.fogBase={near:G.scene.fog.near,far:G.scene.fog.far};
  G.scene.fog.near=G.fogBase.near*(1-G.darkK)+0.5*G.darkK; G.scene.fog.far=G.fogBase.far*(1-G.darkK)+(CONFIG.darkVision+2)*G.darkK;   // inside a blackout you only see a few meters
}

/* =====================================================================
   LIGHTS (flicker + nearest-N pool)
   ===================================================================== */
const tmpCol=new THREE.Color();
function updateLights(dt,cx,cz){
  const lights=G.map.lights, m=G.monster, R=CONFIG.entityFlickerRadius, awake=!m.frozen;
  let zapNear=0;
  lights.forEach((L,k)=>{
    if(L.state==='dead'){ L.level=0; return; }
    const dm=Math.hypot(L.x-m.pos.x,L.z-m.pos.z), bo=blackoutAt(L.x,L.z);
    if(bo){ L.level=bo.t<1.4?(Math.random()<0.3+bo.t*0.45?0.03:0.5+Math.random()*0.5):bo.t<bo.dur?0:(Math.random()<0.55?1:0.08); }   // warning flicker, out, flicker back
    else if(awake&&!m.disguised&&dm<R){                      // the Entity is close: lights go haywire, darker the closer it is
      const close=1-dm/R; L.dt=(L.dt||0)-dt;
      if(L.dt<=0){ L.don=Math.random()>0.3+0.5*close; L.dt=0.02+Math.random()*0.14*(1.2-close); }
      L.level=L.don?0.35+Math.random()*0.65*(1-close*0.5):0.015;
      if((L.x-cx)**2+(L.z-cz)**2<64) zapNear++;
    } else if(L.state==='flicker'){
      L.t-=dt; if(L.t<=0){ L.on=!L.on; L.t=L.on?(Math.random()<0.25?1.5+Math.random()*3:0.04+Math.random()*0.35):0.03+Math.random()*0.22; }
      L.level=L.on?1:0.05;
    } else L.level=1;
    tmpCol.copy(_tint).multiplyScalar(0.02+0.98*L.level); G.panels.setColorAt(k,tmpCol);
  });
  G.panels.instanceColor.needsUpdate=true;
  if(zapNear&&Math.random()<dt*Math.min(10,zapNear*2.5)) SFX.zap(0.04+Math.min(0.1,zapNear*0.02));
  if(SFX.hum) SFX.hum.gain.value=0.03+Math.min(0.05,zapNear*0.012)*(Math.random()<0.5?1:0.2);
  G.poolT-=dt;
  if(G.poolT<=0){ G.poolT=0.15;
    const near=lights.filter(L=>L.state!=='dead').map(L=>({L,d:(L.x-cx)**2+(L.z-cz)**2})).sort((a,b)=>a.d-b.d).slice(0,G.pool.length);
    G.pool.forEach((pl,i)=>{ pl.userData.src=near[i]?near[i].L:null; if(near[i]){ pl.position.x=near[i].L.x; pl.position.z=near[i].L.z; } });
  }
  G.pool.forEach(pl=>{ const L=pl.userData.src; pl.intensity=L?2.1*L.level*(1-0.65*G.darkK):0; });
}


/* =====================================================================
   MODEL VIEWER (menu)
   ===================================================================== */
let VIEW=null;
function openViewer(){
  SET.gfx=PREF.gfx;
  if(camera.parent) camera.parent.remove(camera);
  setupRenderer(); if(!TEX) TEX=makeTextures();
  const scene=new THREE.Scene(); scene.background=FOG.clone(); scene.fog=new THREE.Fog(FOG,6,18);
  scene.add(new THREE.HemisphereLight(srgb(0xe8d39a),srgb(0x4d4120),0.6));
  const key=new THREE.PointLight(srgb(0xfff0cf),2,12,2); key.position.set(1.4,2.9,-1.8); scene.add(key);
  const rim=new THREE.PointLight(srgb(0xfff0cf),1.6,10,2); rim.position.set(-1.6,2.6,2.4); scene.add(rim);
  const cm=TEX.carpet.map.clone(), cn=TEX.carpet.normal.clone(); [cm,cn].forEach(t=>{ t.repeat.set(9,9); t.needsUpdate=true; });
  const fl=new THREE.Mesh(new THREE.CircleGeometry(9,48),new THREE.MeshStandardMaterial({map:cm,normalMap:cn,roughness:1})); fl.rotation.x=-Math.PI/2; scene.add(fl);
  const ent={mesh:makeEntityMesh(),pos:{x:0,z:0},yaw:0,state:'patrol',frozen:false,moving:false,walkPhase:0};
  const sur={mesh:makeSurvivorMesh(0),id:0,mode:'idle',moving:false,stepPhase:0};
  scene.add(ent.mesh); scene.add(sur.mesh); sur.mesh.visible=false;
  VIEW={scene,ent,sur,key,model:'entity',pose:'idle',ang:0.6,elev:0.12,dist:5.2,t:0,auto:true};
  setViewerModel('entity');
  $('menu').classList.add('hidden'); $('viewerUI').classList.remove('hidden');
  SFX.init();
}
function setViewerModel(mdl){
  VIEW.model=mdl; VIEW.ent.mesh.visible=mdl==='entity'; VIEW.sur.mesh.visible=mdl==='suit'; VIEW.dist=mdl==='entity'?5.2:3.0;
  document.querySelectorAll('[data-model]').forEach(o=>o.classList.toggle('on',o.dataset.model===mdl));
  document.querySelector('[data-pose="crouch"]').classList.toggle('hidden',mdl!=='suit');
  document.querySelector('[data-pose="chase"]').textContent=mdl==='suit'?'Sprinting':'Chasing';
  document.querySelector('[data-pose="walk"]').textContent=mdl==='suit'?'Walking':'Stalking';
  setViewerPose(VIEW.pose==='crouch'&&mdl!=='suit'?'idle':VIEW.pose);
}
function setViewerPose(p){
  VIEW.pose=p; document.querySelectorAll('[data-pose]').forEach(o=>o.classList.toggle('on',o.dataset.pose===p));
  const e=VIEW.ent, s=VIEW.sur; e.moving=p==='walk'||p==='chase'; e.state=p==='chase'?'chase':'patrol';
  s.mode=p==='walk'?'walk':p==='chase'?'sprint':p==='crouch'?'crouch':'idle'; s.moving=p==='walk'||p==='chase';
}
function closeViewer(){ VIEW=null; $('viewerUI').classList.add('hidden'); $('menu').classList.remove('hidden'); }
function updateViewer(dt){
  const V=VIEW; V.t+=dt; if(V.auto) V.ang+=dt*0.25;
  const ty=V.model==='entity'?1.6:1.0;
  camera.position.set(Math.sin(V.ang)*V.dist,ty-0.05+V.elev*V.dist,Math.cos(V.ang)*V.dist); camera.lookAt(0,ty,0); camera.rotation.z=0;
  V.key.intensity=Math.random()<0.03?0.25:2;
  if(V.model==='entity'){ V.ent.mesh.position.set(0,0,0); animateEntity(V.ent,dt,V.t); }
  else { const s=V.sur; if(s.moving) s.stepPhase+=dt*speedOf(s.mode)/STEP_LEN[s.mode]; animateSuit(s,dt,V.t); }
}
$('viewBtn').addEventListener('click',openViewer);
$('viewBack').addEventListener('click',closeViewer);
document.querySelectorAll('[data-pose]').forEach(b=>b.addEventListener('click',()=>setViewerPose(b.dataset.pose)));
document.querySelectorAll('[data-model]').forEach(b=>b.addEventListener('click',()=>setViewerModel(b.dataset.model)));
canvas.addEventListener('mousedown',()=>{ if(VIEW) VIEW.auto=false; });
document.addEventListener('mousemove',e=>{ if(!VIEW||!dragging) return; VIEW.ang-=e.movementX*0.008; VIEW.elev=clamp(VIEW.elev+e.movementY*0.004,-0.25,0.6); });
canvas.addEventListener('wheel',e=>{ if(!VIEW) return; e.preventDefault(); VIEW.dist=clamp(VIEW.dist*(1+Math.sign(e.deltaY)*0.1),1.6,10); },{passive:false});

/* =====================================================================
   MAIN LOOP
   ===================================================================== */
let last=performance.now(); const FPS={n:0,t:0,last:performance.now()};
function frame(now){
  requestAnimationFrame(frame);
  updateLookUI();
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  if(PREF.fps){ FPS.n++; FPS.t+=(now-FPS.last)/1000; FPS.last=now; if(FPS.t>=0.5){ $('fps').textContent=Math.round(FPS.n/FPS.t)+' fps'; FPS.n=0; FPS.t=0; } } else FPS.last=now;
  if(VIEW){ updateViewer(dt); renderFrame(VIEW.scene,dt,0); return; }
  if(!G){ renderer.clear(); return; }
  if(!G.paused&&!G.over){ edgeTurn(dt); update(dt); }
  if(!G.paused) draw(dt);
  renderFrame(G.scene,dt,G.fear||0,G.insane||0);
}
function update(dt){
  const p=G.player, m=G.monster;
  updatePlayer(dt);   // your own movement, predicted right away
  p.input={x:p.pos.x,z:p.pos.z,yaw:p.yaw,pitch:p.pitch,mode:p.mode,moving:p.moving,crouch:p.crouching,lean:p.lean||0,leanOff:p.leanOff||0};
  if(G.attackReq){ pushAction({a:'attack',type:G.attackReq}); G.attackReq=null; }
  if(G.net) netUpdate(dt); else step(G,dt);   // offline: run the round here. online: the server runs it
  drainEvents(); if(!G) return;
  updateSanity(dt);
  // "you've been spotted" sting (a disguised Entity gives no warning)
  G.stingCD-=dt; const seenMe=!p.isMonster&&p.alive&&!m.disguised&&!!(m.seen&&m.seen.includes(p.id));
  if(seenMe&&!G.alerted&&G.stingCD<=0){ SFX.sting(); G.stingCD=8; } G.alerted=seenMe;
}
function draw(dt){
  const p=G.player, m=G.monster, t=G.elapsed;
  // camera host
  let host=p, eye;
  if(!p.alive&&G.spectate>=0){ const s=G.survivors.find(s=>s.id===G.spectate); if(s&&s.alive) host=s; else cycleSpectate(); }
  if(host===p){ const crouch=!!p.crouching; G.eye+=((p.isMonster&&!p.disguised?(crouch?1.5:2.45):(crouch?1.0:1.62))-G.eye)*Math.min(1,dt*10); eye=G.eye;
    const back=(!p.isMonster&&p.alive&&!p.inVent&&!G.ejump&&keys.Digit1)?Math.PI:0;
    G.lookBack=(G.lookBack||0)+(back-(G.lookBack||0))*(1-Math.exp(-22*dt));
    camera.rotation.y=p.yaw+G.lookBack; camera.rotation.x=back?0:p.pitch; }
  else { G.camYaw+=angDiff(G.camYaw,host.yaw)*Math.min(1,dt*5); eye=(host.crouching||host.mode==='crouch')?1.0:1.62; camera.rotation.y=G.camYaw; camera.rotation.x=0; }
  if(!G.ejump){ const f=(host===p&&p.isMonster&&m.burstT>0)?PREF.fov+16:PREF.fov; if(Math.abs(camera.fov-f)>0.05){ camera.fov+=(f-camera.fov)*Math.min(1,dt*8); camera.updateProjectionMatrix(); } }
  // animation clocks driven by actual movement (no foot sliding), footsteps synced to the feet
  const cam0=camera.position;
  for(const a of [...G.survivors,m]){
    if(!a.animPos) a.animPos={x:a.pos.x,z:a.pos.z};
    const sp=dt>0?Math.min(14,Math.hypot(a.pos.x-a.animPos.x,a.pos.z-a.animPos.z)/dt):0; a.animPos.x=a.pos.x; a.animPos.z=a.pos.z;
    a.vel=(a.vel||0)+(sp-(a.vel||0))*(1-Math.exp(-12*dt));
    if(!a.alive||a.isMonster) continue;
    const before=Math.floor(a.stepPhase); a.stepPhase+=dt*a.vel/(STEP_LEN[a.mode]||0.72);
    if(Math.floor(a.stepPhase)!==before&&a.vel>0.6&&(a.mode!=='crouch'||isWet(a.pos))&&!a.inVent){
      const wetS=isWet(a.pos);
      if(a===p){ if(wetS) SFX.squelch(null,null,a.mode==='sprint'?0.16:0.1,false); else SFX.step(null,null,a.mode==='sprint'?0.09:0.05,false,true); }
      else if(Math.hypot(a.pos.x-cam0.x,a.pos.z-cam0.z)<(wetS?30:24)){ const mf=!los(cam0.x,cam0.z,a.pos.x,a.pos.z); if(wetS) SFX.squelch(a.pos.x,a.pos.z,0.35,mf); else SFX.step(a.pos.x,a.pos.z,0.22,mf,false); }
    }
  }
  const bw=clamp((host.vel||0)/3,0,1.6)*PREF.bob, bp=host.isMonster?host.walkPhase/Math.PI:host.stepPhase;
  const bob=(0.025-Math.abs(Math.sin(bp*Math.PI))*0.05)*bw*(host.isMonster?1.2:host.mode==='sprint'?1.2:0.8);
  camera.position.set(host.pos.x,eye+bob,host.pos.z);
  if(host.inVent){ camera.position.set(host.inVent.cam.x,0.36,host.inVent.cam.z); eye=0.36; }
  camera.rotation.z=Math.sin(t*0.7)*0.004+Math.sin(bp*Math.PI)*0.007*bw;
  if(host===p&&p.leanOff){ const lx=Math.cos(p.yaw), lz=-Math.sin(p.yaw), lm=p.isMonster?CONFIG.leanEntity:CONFIG.leanSurvivor;
    camera.position.x+=lx*p.leanOff; camera.position.z+=lz*p.leanOff; camera.position.y-=Math.abs(p.leanOff)*0.12; camera.rotation.z-=(p.leanOff/lm)*0.14; }
  SFX.listener(host.pos.x,eye,host.pos.z,camera.rotation.y);
  // meshes
  for(const s of G.survivors){ if(!s.alive) continue; s.mesh.visible=s!==host&&!s.inVent;   // hiders are inside the wall, not standing in front of it
    s.mesh.position.set(s.pos.x,0,s.pos.z); s.mesh.rotation.y=s.yaw; if(s.mesh.visible) animateSuit(s,dt,t); }
  const mm=m.mesh; mm.visible=!m.absent; mm.position.set(m.pos.x,0,m.pos.z); mm.rotation.set(0,m.yaw,0);
  const revealing=m.revealT>0, showFake=m.disguised||(revealing&&Math.random()<m.revealT/CONFIG.revealTime);
  if(G.mimicMesh){ const fa=G.mimicAgent; G.mimicMesh.visible=showFake&&host!==m; G.mimicMesh.position.set(m.pos.x+(revealing?(Math.random()-0.5)*0.15:0),0,m.pos.z); G.mimicMesh.rotation.y=m.yaw;
    fa.vel=m.vel||0; fa.crouching=!!m.crouching; fa.mode=m.crouching?'crouch':fa.vel>0.3?'walk':'idle'; fa.moving=fa.vel>0.3; const b4=Math.floor(fa.stepPhase); fa.stepPhase+=dt*fa.vel/STEP_LEN.walk;
    if(G.mimicMesh.visible) animateSuit(fa,dt,t);
    if(m.disguised&&Math.floor(fa.stepPhase)!==b4&&fa.vel>0.6&&!m.crouching&&m!==p&&Math.hypot(m.pos.x-camera.position.x,m.pos.z-camera.position.z)<24) SFX.step(m.pos.x,m.pos.z,0.22,!los(camera.position.x,camera.position.z,m.pos.x,m.pos.z),false); }
  if(m.disguised||(revealing&&showFake)) mm.visible=false;
  mm.userData.spine[0].pv.visible=!(m.isPlayer&&host===p); mm.userData.legs[0].th.pv.parent.parent.children[0].visible=!(m.isPlayer&&host===p); mm.userData.haze.forEach(h=>h.visible=!(m.isPlayer&&host===p));
  animateEntity(m,dt,t);
  const eStep=Math.floor(m.walkPhase/Math.PI); if(m.lastStep!==undefined&&eStep!==m.lastStep&&m.vel>0.8&&!m.disguised){ if(m===p) SFX.step(null,null,m.crouching?0.04:0.12,false,true); else if(Math.hypot(m.pos.x-cam0.x,m.pos.z-cam0.z)<30) SFX.step(m.pos.x,m.pos.z,m.crouching?0.18:0.6,!los(cam0.x,cam0.z,m.pos.x,m.pos.z),false); } m.lastStep=eStep;
  if(G.vm){ G.vm.visible=host===p&&!m.disguised; animateEntityViewArms(G.vm,m,dt,t); }
  if(G.ejump) runEntityJump(dt,t);
  for(const c of G.corpses) updateCorpse(c,dt,G.elapsed);
  updateAtmosphere(dt,camera.position); updateLights(dt,host.pos.x,host.pos.z); updateMotes(G.motes,camera.position,dt,t);
  // HUD
  $('timer').textContent=fmt(G.timeLeft); $('timer').style.color=G.timeLeft<30?'#f3c96b':'';
  const aliveN=G.survivors.filter(s=>s.alive).length; $('alive').textContent=G.survivors.length?`${aliveN}/${G.survivors.length} survivors left`:'no survivors (AI off)';
  if(!p.isMonster){ $('stam').style.width=(p.stamina*100)+'%'; $('stam').classList.toggle('tired',p.exhausted); $('cool').textContent=p.exhausted?'exhausted '+Math.ceil(p.exhaustT)+'s':''; }
  if(m.frozen) $('msg').textContent=(p.isMonster?'Feast begins in ':'Hunt begins in ')+Math.ceil(CONFIG.freezeTime-G.elapsed);
  else if(G.msgT>0){ G.msgT-=dt; if(G.msgT<=0) $('msg').textContent=''; }
  else if(!p.alive) $('msg').textContent=G.spectate>=0?'◄  spectating '+(G.survivors.find(s=>s.id===G.spectate)||{}).name+'  ►':'';
  else $('msg').textContent='';
  if(p.isMonster){ const cd=(n,k,v)=>`[${k}] ${n} `+(v>0?v.toFixed(1)+'s':'ready'); $('cool').textContent=m.frozen?'':[cd('Bite','1',m.biteCD),cd('Swipe','2',m.swipeCD),m.ability==='mimic'?(m.disguised?'DISGUISED · [Shift] unveil':m.revealT>0?'UNVEILING…':cd('Mimic','Shift',m.mimicCD)):(m.burstT>0?'BURST!':cd('Dash','Shift',m.burstCD)),cd('Rip vent','E',m.ripCD)].join('   ·   '); }
  $('cross').style.display=p.alive?'':'none';
  // heartbeat + vignette (survivor view)
  let fear=0;
  if(!host.isMonster&&host.alive&&!m.frozen&&!G.over&&!m.disguised){ const d=dist2(host.pos,m.pos); fear=clamp(1-d/24,0,1);
    if(fear>0){ G.beatT-=dt; if(G.beatT<=0){ G.beatT=0.36+(1-fear)*0.85; const v=0.15+0.5*fear; SFX.thump(v); SFX.thump(v*0.7,0.17); } } }
  if(G.ejump) fear=1;
  $('vignette').style.opacity=(fear*0.75).toFixed(2); G.fear=fear;
  G.flash=Math.max(0,G.flash-dt*0.7); $('flash').style.opacity=G.flash.toFixed(2);
  // monster sound cues
  ovg.clearRect(0,0,ov.width,ov.height);
  drawVentFX(dt,t,host);
}
requestAnimationFrame(frame);

// expose for testing
window.__game={generateMap,bfs,neighbors,CONFIG,get G(){return G;}};


/* =====================================================================
   DEBUG HOOKS: add ?debug to the URL (or run `npm run dev`) to reach game
   internals from the console, e.g. G.monster, startGame('1234')
   ===================================================================== */
if(import.meta.env.DEV||new URLSearchParams(location.search).has('debug')) Object.defineProperties(window,{
  $:{get:()=>$,configurable:true},
  ANOMALIES:{get:()=>ANOMALIES,configurable:true},
  BASE_CONFIG:{get:()=>BASE_CONFIG,configurable:true},
  BOT_NAMES:{get:()=>BOT_NAMES,configurable:true},
  BOXES:{get:()=>BOXES,configurable:true},
  CONFIG:{get:()=>CONFIG,configurable:true},
  CopyShader:{get:()=>CopyShader,configurable:true},
  ENTITY_ID:{get:()=>ENTITY_ID,configurable:true},
  EffectComposer:{get:()=>EffectComposer,configurable:true},
  FINAL_SHADER:{get:()=>FINAL_SHADER,configurable:true},
  FOG:{get:()=>FOG,configurable:true},
  FOG_RED:{get:()=>FOG_RED,configurable:true},
  FPS:{get:()=>FPS,configurable:true},
  G:{get:()=>G, set:v=>{G=v;},configurable:true},
  GAME_VERSION:{get:()=>GAME_VERSION,configurable:true},
  GLOW_TEX:{get:()=>GLOW_TEX, set:v=>{GLOW_TEX=v;},configurable:true},
  HAZE_TEX:{get:()=>HAZE_TEX, set:v=>{HAZE_TEX=v;},configurable:true},
  HEMI_GND:{get:()=>HEMI_GND,configurable:true},
  HEMI_RGND:{get:()=>HEMI_RGND,configurable:true},
  HEMI_RSKY:{get:()=>HEMI_RSKY,configurable:true},
  HEMI_SKY:{get:()=>HEMI_SKY,configurable:true},
  HI:{get:()=>HI,configurable:true},
  LIGHT_RED:{get:()=>LIGHT_RED,configurable:true},
  LIGHT_WARM:{get:()=>LIGHT_WARM,configurable:true},
  LOBBY:{get:()=>LOBBY, set:v=>{LOBBY=v;},configurable:true},
  LUMP_GEO:{get:()=>LUMP_GEO, set:v=>{LUMP_GEO=v;},configurable:true},
  LuminosityHighPassShader:{get:()=>LuminosityHighPassShader,configurable:true},
  MAP:{get:()=>MAP,configurable:true},
  NET:{get:()=>NET, set:v=>{NET=v;},configurable:true},
  PANELS:{get:()=>PANELS,configurable:true},
  POOL_TEX:{get:()=>POOL_TEX, set:v=>{POOL_TEX=v;},configurable:true},
  POST_OK:{get:()=>POST_OK,configurable:true},
  PREF:{get:()=>PREF,configurable:true},
  PUDDLE_TEX:{get:()=>PUDDLE_TEX, set:v=>{PUDDLE_TEX=v;},configurable:true},
  ROUND_TIME:{get:()=>ROUND_TIME,configurable:true},
  RenderPass:{get:()=>RenderPass,configurable:true},
  SERVER_URL:{get:()=>SERVER_URL,configurable:true},
  SET:{get:()=>SET,configurable:true},
  SFX:{get:()=>SFX,configurable:true},
  SIM:{get:()=>SIM,configurable:true},
  SM:{get:()=>SM,configurable:true},
  SMILER_CANVAS:{get:()=>SMILER_CANVAS, set:v=>{SMILER_CANVAS=v;},configurable:true},
  SMILER_TEX:{get:()=>SMILER_TEX, set:v=>{SMILER_TEX=v;},configurable:true},
  STEP_LEN:{get:()=>STEP_LEN,configurable:true},
  ShaderPass:{get:()=>ShaderPass,configurable:true},
  TEAM_COLORS:{get:()=>TEAM_COLORS,configurable:true},
  TEX:{get:()=>TEX, set:v=>{TEX=v;},configurable:true},
  THREE:{get:()=>THREE,configurable:true},
  TINT_RED:{get:()=>TINT_RED,configurable:true},
  TINT_WARM:{get:()=>TINT_WARM,configurable:true},
  UnrealBloomPass:{get:()=>UnrealBloomPass,configurable:true},
  VIEW:{get:()=>VIEW, set:v=>{VIEW=v;},configurable:true},
  _ce:{get:()=>_ce,configurable:true},
  _cm:{get:()=>_cm,configurable:true},
  _cp:{get:()=>_cp,configurable:true},
  _cq:{get:()=>_cq,configurable:true},
  _cs:{get:()=>_cs,configurable:true},
  _hw:{get:()=>_hw,configurable:true},
  _tint:{get:()=>_tint,configurable:true},
  addInteractable:{get:()=>addInteractable,configurable:true},
  agentById:{get:()=>agentById,configurable:true},
  angDiff:{get:()=>angDiff,configurable:true},
  animateEntity:{get:()=>animateEntity,configurable:true},
  animateEntityViewArms:{get:()=>animateEntityViewArms,configurable:true},
  animateSuit:{get:()=>animateSuit,configurable:true},
  applyFov:{get:()=>applyFov,configurable:true},
  applySnapshot:{get:()=>applySnapshot,configurable:true},
  beginRound:{get:()=>beginRound,configurable:true},
  bfs:{get:()=>bfs,configurable:true},
  bindRound:{get:()=>bindRound,configurable:true},
  blackoutAt:{get:()=>blackoutAt,configurable:true},
  blob:{get:()=>blob,configurable:true},
  bloomPass:{get:()=>bloomPass, set:v=>{bloomPass=v;},configurable:true},
  buildColliders:{get:()=>buildColliders,configurable:true},
  buildScene:{get:()=>buildScene,configurable:true},
  camera:{get:()=>camera,configurable:true},
  canSee:{get:()=>canSee,configurable:true},
  canvas:{get:()=>canvas,configurable:true},
  cellOf:{get:()=>cellOf,configurable:true},
  chooseAbility:{get:()=>chooseAbility,configurable:true},
  clamp:{get:()=>clamp,configurable:true},
  cleanName:{get:()=>cleanName,configurable:true},
  closeViewer:{get:()=>closeViewer,configurable:true},
  collide:{get:()=>collide,configurable:true},
  composer:{get:()=>composer, set:v=>{composer=v;},configurable:true},
  createRound:{get:()=>createRound,configurable:true},
  cycleSpectate:{get:()=>cycleSpectate,configurable:true},
  dist2:{get:()=>dist2,configurable:true},
  dragging:{get:()=>dragging, set:v=>{dragging=v;},configurable:true},
  drainEvents:{get:()=>drainEvents,configurable:true},
  draw:{get:()=>draw,configurable:true},
  drawVentFX:{get:()=>drawVentFX,configurable:true},
  endRound:{get:()=>endRound,configurable:true},
  entitySpeed:{get:()=>entitySpeed,configurable:true},
  esc:{get:()=>esc,configurable:true},
  feed:{get:()=>feed,configurable:true},
  finalPass:{get:()=>finalPass, set:v=>{finalPass=v;},configurable:true},
  fmt:{get:()=>fmt,configurable:true},
  frame:{get:()=>frame,configurable:true},
  generateMap:{get:()=>generateMap,configurable:true},
  handleEvent:{get:()=>handleEvent,configurable:true},
  hashSeed:{get:()=>hashSeed,configurable:true},
  initModeButtons:{get:()=>initModeButtons,configurable:true},
  isDark:{get:()=>isDark,configurable:true},
  isWet:{get:()=>isWet,configurable:true},
  joinRoom:{get:()=>joinRoom,configurable:true},
  keys:{get:()=>keys,configurable:true},
  last:{get:()=>last, set:v=>{last=v;},configurable:true},
  lathe:{get:()=>lathe,configurable:true},
  leaveGame:{get:()=>leaveGame,configurable:true},
  lobbyTick:{get:()=>lobbyTick,configurable:true},
  lobbyTimer:{get:()=>lobbyTimer, set:v=>{lobbyTimer=v;},configurable:true},
  lockPointer:{get:()=>lockPointer,configurable:true},
  locked:{get:()=>locked, set:v=>{locked=v;},configurable:true},
  los:{get:()=>los,configurable:true},
  makeCarpetTex:{get:()=>makeCarpetTex,configurable:true},
  makeCeilTex:{get:()=>makeCeilTex,configurable:true},
  makeCorpse:{get:()=>makeCorpse,configurable:true},
  makeDuct:{get:()=>makeDuct,configurable:true},
  makeEntityMesh:{get:()=>makeEntityMesh,configurable:true},
  makeEntityViewArms:{get:()=>makeEntityViewArms,configurable:true},
  makeRng:{get:()=>makeRng,configurable:true},
  makeSkinTex:{get:()=>makeSkinTex,configurable:true},
  makeSuitTex:{get:()=>makeSuitTex,configurable:true},
  makeSurvivorMesh:{get:()=>makeSurvivorMesh,configurable:true},
  makeTextures:{get:()=>makeTextures,configurable:true},
  makeVentMesh:{get:()=>makeVentMesh,configurable:true},
  makeWallTex:{get:()=>makeWallTex,configurable:true},
  mkCanvas:{get:()=>mkCanvas,configurable:true},
  nearby:{get:()=>nearby,configurable:true},
  nearestInteractable:{get:()=>nearestInteractable,configurable:true},
  neighbors:{get:()=>neighbors,configurable:true},
  netLeave:{get:()=>netLeave,configurable:true},
  netUpdate:{get:()=>netUpdate,configurable:true},
  noLock:{get:()=>noLock, set:v=>{noLock=v;},configurable:true},
  noise:{get:()=>noise,configurable:true},
  noiseRadius:{get:()=>noiseRadius,configurable:true},
  normalFromHeight:{get:()=>normalFromHeight,configurable:true},
  onCaught:{get:()=>onCaught,configurable:true},
  openLobby:{get:()=>openLobby,configurable:true},
  openPanel:{get:()=>openPanel,configurable:true},
  openViewer:{get:()=>openViewer,configurable:true},
  ov:{get:()=>ov,configurable:true},
  ovg:{get:()=>ovg,configurable:true},
  panelReturn:{get:()=>panelReturn, set:v=>{panelReturn=v;},configurable:true},
  pathFrom:{get:()=>pathFrom,configurable:true},
  pauseGame:{get:()=>pauseGame,configurable:true},
  pickAnomaly:{get:()=>pickAnomaly,configurable:true},
  pickEntity:{get:()=>pickEntity,configurable:true},
  playerName:{get:()=>playerName,configurable:true},
  pointBlocked:{get:()=>pointBlocked,configurable:true},
  pushAction:{get:()=>pushAction,configurable:true},
  radialTex:{get:()=>radialTex,configurable:true},
  randomSeed:{get:()=>randomSeed,configurable:true},
  renderAbilityPick:{get:()=>renderAbilityPick,configurable:true},
  renderFrame:{get:()=>renderFrame,configurable:true},
  renderLobby:{get:()=>renderLobby,configurable:true},
  renderPass:{get:()=>renderPass, set:v=>{renderPass=v;},configurable:true},
  renderer:{get:()=>renderer,configurable:true},
  resetConfig:{get:()=>resetConfig,configurable:true},
  resize:{get:()=>resize,configurable:true},
  resumeGame:{get:()=>resumeGame,configurable:true},
  rosterBotNames:{get:()=>rosterBotNames,configurable:true},
  runEntityJump:{get:()=>runEntityJump,configurable:true},
  saveSettings:{get:()=>saveSettings,configurable:true},
  setBots:{get:()=>setBots,configurable:true},
  setEntity:{get:()=>setEntity,configurable:true},
  setViewerModel:{get:()=>setViewerModel,configurable:true},
  setViewerPose:{get:()=>setViewerPose,configurable:true},
  setWorld:{get:()=>setWorld,configurable:true},
  setupRenderer:{get:()=>setupRenderer,configurable:true},
  showMsg:{get:()=>showMsg,configurable:true},
  showOnlineLobby:{get:()=>showOnlineLobby,configurable:true},
  smilerCanvas:{get:()=>smilerCanvas,configurable:true},
  speedOf:{get:()=>speedOf,configurable:true},
  srgb:{get:()=>srgb,configurable:true},
  stainOverlay:{get:()=>stainOverlay,configurable:true},
  startGame:{get:()=>startGame,configurable:true},
  step:{get:()=>step,configurable:true},
  syncSettingsUI:{get:()=>syncSettingsUI,configurable:true},
  tmpCol:{get:()=>tmpCol,configurable:true},
  toTex:{get:()=>toTex,configurable:true},
  tryInteract:{get:()=>tryInteract,configurable:true},
  turnToward:{get:()=>turnToward,configurable:true},
  update:{get:()=>update,configurable:true},
  updateAtmosphere:{get:()=>updateAtmosphere,configurable:true},
  updateCorpse:{get:()=>updateCorpse,configurable:true},
  updateLights:{get:()=>updateLights,configurable:true},
  updateMotes:{get:()=>updateMotes,configurable:true},
  updatePlayer:{get:()=>updatePlayer,configurable:true},
  updateSanity:{get:()=>updateSanity,configurable:true},
  updateViewer:{get:()=>updateViewer,configurable:true},
  usableVent:{get:()=>usableVent,configurable:true},
  catchSurvivor:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.catchSurvivor(...a); drainEvents(); return r; },configurable:true},
  toggleMimic:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.toggleMimic(...a); drainEvents(); return r; },configurable:true},
  entityAttack:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.entityAttack(...a); drainEvents(); return r; },configurable:true},
  ripVent:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.ripVent(...a); drainEvents(); return r; },configurable:true},
  enterVent:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.enterVent(...a); drainEvents(); return r; },configurable:true},
  exitVent:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.exitVent(...a); drainEvents(); return r; },configurable:true},
  perceive:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.perceive(...a); drainEvents(); return r; },configurable:true},
  updateBotSurvivor:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.updateBotSurvivor(...a); drainEvents(); return r; },configurable:true},
  updateMonsterBot:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.updateMonsterBot(...a); drainEvents(); return r; },configurable:true},
  useAbility:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.useAbility(...a); drainEvents(); return r; },configurable:true},
  attackTarget:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.attackTarget(...a); drainEvents(); return r; },configurable:true},
  entityBurst:{get:()=>(...a)=>{ bindRound(G); const r=SIM.DEBUG.entityBurst(...a); drainEvents(); return r; },configurable:true}
});
