// Collision and line of sight
// Shared between the browser client and the game server. No DOM, no three.js in here.

import { CONFIG } from './config.js';
import { clamp } from './rng.js';

export let MAP=null, BOXES=null;
// the map every collision/LOS call works against (set once per round)
export function setWorld(map,boxes){ MAP=map; BOXES=map?(boxes||buildColliders(map)):null; }
export function buildColliders(map){
  const {N,S,h,v}=map, T=CONFIG.wallThick, boxes=[];
  for(let y=0;y<=N;y++) for(let x=0;x<N;x++) if(h[y][x]) boxes.push({x0:x*S-T/2,x1:(x+1)*S+T/2,z0:y*S-T/2,z1:y*S+T/2});
  for(let y=0;y<N;y++) for(let x=0;x<=N;x++) if(v[y][x]) boxes.push({x0:x*S-T/2,x1:x*S+T/2,z0:y*S-T/2,z1:(y+1)*S+T/2});
  for(const p of map.pillars) boxes.push({x0:p.x*S-0.3,x1:p.x*S+0.3,z0:p.y*S-0.3,z1:p.y*S+0.3});
  const buckets=Array.from({length:N*N},()=>[]);
  for(const b of boxes){
    const cx0=clamp(Math.floor((b.x0-1)/S),0,N-1), cx1=clamp(Math.floor((b.x1+1)/S),0,N-1);
    const cz0=clamp(Math.floor((b.z0-1)/S),0,N-1), cz1=clamp(Math.floor((b.z1+1)/S),0,N-1);
    for(let z=cz0;z<=cz1;z++) for(let x=cx0;x<=cx1;x++) buckets[x+z*N].push(b);
  }
  return {boxes,buckets};
}
export function cellOf(p){ return [clamp(Math.floor(p.x/MAP.S),0,MAP.N-1), clamp(Math.floor(p.z/MAP.S),0,MAP.N-1)]; }
export function nearby(x,z){ const [cx,cz]=cellOf({x,z}); return BOXES.buckets[cx+cz*MAP.N]; }
export function pointBlocked(x,z,r){
  for(const b of nearby(x,z)){ const cx=clamp(x,b.x0,b.x1), cz=clamp(z,b.z0,b.z1), dx=x-cx, dz=z-cz; if(dx*dx+dz*dz<r*r) return true; }
  return false;
}
export function collide(p,r){
  const W=MAP.N*MAP.S;
  for(let it=0;it<2;it++){
    for(const b of nearby(p.x,p.z)){
      const cx=clamp(p.x,b.x0,b.x1), cz=clamp(p.z,b.z0,b.z1); const dx=p.x-cx, dz=p.z-cz, d2=dx*dx+dz*dz;
      if(d2>=r*r) continue;
      if(d2>1e-9){ const d=Math.sqrt(d2); p.x+=dx/d*(r-d); p.z+=dz/d*(r-d); }
      else { const pl=p.x-b.x0, pr=b.x1-p.x, pu=p.z-b.z0, pd=b.z1-p.z, m=Math.min(pl,pr,pu,pd);
        if(m===pl)p.x=b.x0-r; else if(m===pr)p.x=b.x1+r; else if(m===pu)p.z=b.z0-r; else p.z=b.z1+r; }
    }
  }
  p.x=clamp(p.x,r,W-r); p.z=clamp(p.z,r,W-r);
}
export function los(ax,az,bx,bz,r=0.03){
  const dx=bx-ax, dz=bz-az, d=Math.hypot(dx,dz), steps=Math.ceil(d/0.25);
  for(let i=1;i<steps;i++){ const t=i/steps; if(pointBlocked(ax+dx*t,az+dz*t,r)) return false; }
  return true;
}
