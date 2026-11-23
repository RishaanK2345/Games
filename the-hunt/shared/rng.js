// Seeded RNG: the same seed gives the same result on every machine
// Shared between the browser client and the game server. No DOM, no three.js in here.

export function hashSeed(str){ let h=1779033703^str.length; for(let i=0;i<str.length;i++){ h=Math.imul(h^str.charCodeAt(i),3432918353); h=h<<13|h>>>19; } return ()=>{ h=Math.imul(h^h>>>16,2246822507); h=Math.imul(h^h>>>13,3266489909); return (h^=h>>>16)>>>0; }; }
export function makeRng(seedStr){ let a=hashSeed(String(seedStr))(); return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
export const clamp=(v,a,b)=>v<a?a:v>b?b:v;
export const dist2=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
