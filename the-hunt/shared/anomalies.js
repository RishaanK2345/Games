// Per-round anomalies (picked from the seed)
// Shared between the browser client and the game server. No DOM, no three.js in here.

import { makeRng } from './rng.js';

export const ANOMALIES=[
  {id:'none',w:3},
  {id:'blackout',name:'BLACKOUT SHIFT',desc:'Most of the lights are dead. The rest are failing.',w:2,apply:c=>{ c.deadLightChance=0.3; c.flickerChance=0.4; c.darkWings=4; c.surgeDark=3; }},
  {id:'flooded',name:'FLOODED',desc:'The carpet is soaked almost everywhere. Every step squelches.',w:2,apply:c=>{ c.wetDensity=0.45; }},
  {id:'fog',name:'THICK AIR',desc:'You can barely see past your own hands. Neither can it.',w:2,apply:c=>{ c.fogFar=11; c.visionRange=14; }},
  {id:'shift',name:'WRONG WAY',desc:'The halls rearrange themselves. Don\'t trust the way you came.',w:2,apply:c=>{ c.wallShifts=true; }},
  {id:'phantoms',name:'PHANTOMS',desc:'You keep hearing someone. There is no one there.',w:2,apply:c=>{ c.phantoms=true; }},
  {id:'vents',name:'VENT INFESTATION',desc:'Vents everywhere, and the smilers are restless.',w:2,apply:c=>{ c.ventDensity=0.065; c.ventWarn=9; c.ventSmilers=13; c.ventDeath=17; }},
];
export function pickAnomaly(seed,enabled=true){
  if(!enabled) return ANOMALIES[0];
  const r=makeRng(seed+'#anomaly')(), tot=ANOMALIES.reduce((a,b)=>a+b.w,0); let acc=0;
  for(const a of ANOMALIES){ acc+=a.w/tot; if(r<acc) return a; } return ANOMALIES[0];
}
