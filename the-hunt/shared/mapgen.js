// Procedural Level 0 map generator
// Shared between the browser client and the game server. No DOM, no three.js in here.

import { CONFIG } from './config.js';
import { makeRng } from './rng.js';

export function generateMap(seed){
  const rnd=makeRng(seed), N=CONFIG.cells, ri=n=>Math.floor(rnd()*n);
  const h=Array.from({length:N+1},()=>Array(N).fill(true));
  const v=Array.from({length:N},()=>Array(N+1).fill(true));
  const DIRS=[[0,-1],[0,1],[-1,0],[1,0]];
  const open=(x,y,d)=>{ if(d===0)h[y][x]=false; else if(d===1)h[y+1][x]=false; else if(d===2)v[y][x]=false; else v[y][x+1]=false; };
  const wallCount=(x,y)=>(h[y][x]?1:0)+(h[y+1][x]?1:0)+(v[y][x]?1:0)+(v[y][x+1]?1:0);

  // 1) recursive backtracker = spanning tree (guarantees full connectivity)
  const vis=Array.from({length:N},()=>Array(N).fill(false));
  const stack=[[ri(N),ri(N)]]; vis[stack[0][1]][stack[0][0]]=true;
  while(stack.length){
    const [x,y]=stack[stack.length-1]; const nb=[];
    DIRS.forEach(([dx,dy],d)=>{ const nx=x+dx, ny=y+dy; if(nx>=0&&ny>=0&&nx<N&&ny<N&&!vis[ny][nx]) nb.push([nx,ny,d]); });
    if(!nb.length){ stack.pop(); continue; }
    const [nx,ny,d]=nb[ri(nb.length)]; open(x,y,d); vis[ny][nx]=true; stack.push([nx,ny]);
  }
  // 2) braid: open most dead ends so the monster can't corner people
  for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    if(wallCount(x,y)===3 && rnd()<CONFIG.braidChance){
      const c=[]; if(y>0&&h[y][x])c.push(0); if(y<N-1&&h[y+1][x])c.push(1); if(x>0&&v[y][x])c.push(2); if(x<N-1&&v[y][x+1])c.push(3);
      if(c.length) open(x,y,c[ri(c.length)]);
    }
  }
  // 3) extra random loops
  for(let y=1;y<N;y++) for(let x=0;x<N;x++) if(h[y][x]&&rnd()<CONFIG.loopChance) h[y][x]=false;
  for(let y=0;y<N;y++) for(let x=1;x<N;x++) if(v[y][x]&&rnd()<CONFIG.loopChance) v[y][x]=false;
  // 4) open rooms with pillars
  const pillars=[], rooms=[];
  for(let i=0;i<CONFIG.rooms;i++){
    const w=2+ri(3), hh=2+ri(3), rx=ri(N-w+1), ry=ri(N-hh+1); rooms.push({rx,ry,w,hh});
    for(let y=ry;y<ry+hh;y++) for(let x=rx;x<rx+w;x++){ if(x>rx) v[y][x]=false; if(y>ry) h[y][x]=false; }
    for(let y=ry+1;y<ry+hh;y++) for(let x=rx+1;x<rx+w;x++) if(rnd()<CONFIG.pillarChance) pillars.push({x,y});
  }
  // 5) long straight hallways (only removes walls, so connectivity is preserved)
  for(let i=0;i<CONFIG.longHalls;i++){ const len=6+ri(5);
    if(rnd()<0.5){ const y=ri(N), x0=ri(Math.max(1,N-len)); for(let x=x0+1;x<Math.min(N,x0+len);x++) v[y][x]=false; }
    else { const x=ri(N), y0=ri(Math.max(1,N-len)); for(let y=y0+1;y<Math.min(N,y0+len);y++) h[y][x]=false; } }
  // 6) soaked carpet patches
  const wet=new Set(); const wetTarget=Math.round(N*N*CONFIG.wetDensity);
  for(let g=0;g<200&&wet.size<wetTarget;g++){ const cx=ri(N), cy=ri(N), r=1+ri(2); for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++) if(x>=0&&y>=0&&x<N&&y<N&&Math.abs(x-cx)+Math.abs(y-cy)<=r&&rnd()<0.85) wet.add(x+y*N); }
  // 7) ceiling lights: dark wings, dead clusters, flicker
  const lights=[]; const dead=new Set();
  for(let i=0;i<CONFIG.darkWings;i++){ const cx=ri(N), cy=ri(N), r=2+ri(2); for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++) if(Math.hypot(x-cx,y-cy)<=r+0.3) dead.add(x+','+y); }
  const clusters=Math.max(2,Math.round(N*N*0.03));
  for(let i=0;i<clusters;i++){ const cx=ri(N), cy=ri(N), r=1+ri(2); for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++) dead.add(x+','+y); }
  for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    if(rnd()>CONFIG.lightChance) continue;
    let state='on'; if(dead.has(x+','+y)||rnd()<CONFIG.deadLightChance) state='dead'; else if(rnd()<CONFIG.flickerChance) state='flicker';
    lights.push({x:(x+0.5)*CONFIG.cellSize, z:(y+0.5)*CONFIG.cellSize, state, level:state==='dead'?0:1, on:true, t:rnd()*2});
  }
  return {N,S:CONFIG.cellSize,h,v,pillars,rooms,lights,wet,rnd,seed};
}
export function neighbors(map,x,y){
  const {N,h,v}=map, out=[];
  if(y>0&&!h[y][x])out.push([x,y-1]); if(y<N-1&&!h[y+1][x])out.push([x,y+1]);
  if(x>0&&!v[y][x])out.push([x-1,y]); if(x<N-1&&!v[y][x+1])out.push([x+1,y]);
  return out;
}
export function bfs(map,sx,sy,blocked){
  const N=map.N, dist=new Int16Array(N*N).fill(-1), prev=new Int16Array(N*N).fill(-1);
  const s=sx+sy*N; dist[s]=0; const q=[s]; let i=0;
  while(i<q.length){ const c=q[i++], x=c%N, y=(c/N)|0;
    for(const [nx,ny] of neighbors(map,x,y)){ const n=nx+ny*N; if(dist[n]>=0) continue; if(blocked&&blocked(n)) continue; dist[n]=dist[c]+1; prev[n]=c; q.push(n); } }
  return {dist,prev};
}
export function pathFrom(map,res,sx,sy,t){
  const N=map.N, s=sx+sy*N; if(res.dist[t]<0) return [];
  const out=[]; let c=t; while(c!==s&&c>=0){ out.push(c); c=res.prev[c]; }
  out.reverse(); return out.map(c=>({x:(c%N+0.5)*map.S, z:(((c/N)|0)+0.5)*map.S}));
}
