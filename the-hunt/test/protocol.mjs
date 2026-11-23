// Headless 2-player protocol test. Start the server first (npm run server), then: npm run test:server
import { Client } from '@colyseus/sdk';
const c=new Client('ws://localhost:2567'); const log=(...a)=>console.log(...a);
const A=await c.joinOrCreate('level0',{code:'4242',name:'Ghosty',v:2,size:12});
const B=await c.joinOrCreate('level0',{code:'4242',name:'Lars',v:2});
let LA=null, startA=null, startB=null, evA=[], snapA=0, lastSnap=null, fixA=0;
A.onMessage('lobby',L=>LA=L); B.onMessage('lobby',()=>{});
A.onMessage('start',o=>startA=o); B.onMessage('start',o=>startB=o);
A.onMessage('ev',e=>evA.push(...e)); B.onMessage('ev',()=>{});
A.onMessage('s',s=>{snapA++; lastSnap=s;}); B.onMessage('s',()=>{});
A.onMessage('fix',()=>fixA++); B.onMessage('fix',()=>{});
A.send('hello'); B.send('hello');
await new Promise(r=>setTimeout(r,300));
log('lobby:',LA.players.map(p=>`${p.name}${p.host?'(host)':''}${p.bot?'[bot]':''}`).join(', '),'entity',LA.entity);
// wrong version / bad join
try{ await c.joinOrCreate('level0',{code:'4242',name:'Old',v:1}); log('old version JOINED (bad)'); }catch(e){ log('old version rejected:',e.message); }
// non-host can't pick entity; host picks Lars
B.send('entity',A.sessionId); await new Promise(r=>setTimeout(r,150)); log('non-host pick ignored:',LA.entity===-1);
A.send('entity',B.sessionId); await new Promise(r=>setTimeout(r,150)); log('host picked Lars ->', LA.players[LA.entity]?.name);
A.send('ready',true); B.send('ready',true); await new Promise(r=>setTimeout(r,500)); log('countdown:',LA.countdown);
await new Promise(r=>setTimeout(r,3200));
log('started both:',!!startA&&!!startB,'same opts:',JSON.stringify(startA)===JSON.stringify(startB));
log('roster:',startA.roster.map(r=>`${r.name}${r.human?'*':''}`).join(','),'entity idx',startA.entity);
// joining mid-round is refused
try{ await c.joinOrCreate('level0',{code:'4242',name:'Late',v:2}); log('late JOINED (bad)'); }catch(e){ log('late join rejected:',e.message); }
// A (survivor) walks: send legit then a teleport
await new Promise(r=>setTimeout(r,500));
const me=lastSnap.s.find(r=>r[0]===0); log('A spawn',me[1],me[2]);
let x=me[1], z=me[2];
for(let i=0;i<20;i++){ x+=0.1; A.send('input',{x,z,yaw:0,pitch:0,mode:'walk',moving:true,crouch:false}); await new Promise(r=>setTimeout(r,50)); }
const after=lastSnap.s.find(r=>r[0]===0); log('legit walk accepted: moved',(after[1]-me[1]).toFixed(2),'m (sent 2.0, walls may block) fixes',fixA);
A.send('input',{x:x+30,z,yaw:0,pitch:0,mode:'walk',moving:true}); await new Promise(r=>setTimeout(r,300));
const tp=lastSnap.s.find(r=>r[0]===0); log('teleport 30m blocked: server x moved',(tp[1]-after[1]).toFixed(2),'fixes',fixA);
log('snapshots in ~4s:',snapA,'events so far:',evA.map(e=>e.t).join(','));
// B (entity) leaves mid-round -> bot takes over
await B.leave(); await new Promise(r=>setTimeout(r,400));
log('after B left:',evA.filter(e=>e.t==='left').map(e=>e.name));
const sb=lastSnap.m; await new Promise(r=>setTimeout(r,16000));
log('entity unfrozen & moving as bot:', lastSnap.m.frozen===0, 'moved', Math.hypot(lastSnap.m.x-sb.x,lastSnap.m.z-sb.z).toFixed(1),'m');
await A.leave(); process.exit(0);
