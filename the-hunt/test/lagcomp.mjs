// Lag compensation check (no server needed): node test/lagcomp.mjs
import { createRound, step, bindRound, ENTITY_ID } from '../shared/sim.js';
import { CONFIG } from '../shared/config.js';
import { los, pointBlocked } from '../shared/physics.js';

const roster = ['Ent', 'S1'].map((name, i) => ({ name, human: true, pid: 'p' + i }));
function trial(lagComp, viewDelay, runSpeed) {
  const W = createRound({ seed: '777', size: 16, anomalies: false, roster, entity: 0 }); W.lagComp = lagComp;
  const m = W.monster, s = W.survivors[0];
  while (W.elapsed < CONFIG.freezeTime + 0.1) { step(W, 1 / 30); W.events.length = 0; }
  bindRound(W);
  // find an open straight line: Entity at A, survivor 0.8 m ahead running straight away
  for (let c = 0; c < W.map.N * W.map.N; c++) {
    const N = W.map.N, S = W.map.S, x = (c % N + 0.5) * S, z = (((c / N) | 0) + 0.5) * S;
    for (let k = 0; k < 8; k++) { const yaw = k * Math.PI / 4, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      if ([0.5, 1, 2, 3].every(d => !pointBlocked(x + fx * d, z + fz * d, 0.45)) && los(x, z, x + fx * 3, z + fz * 3)) {
        m.pos = { x, z }; m.yaw = yaw; s.pos = { x: x + fx * 0.8, z: z + fz * 0.8 };
        // survivor runs away for 0.25 s; the Entity's screen still shows it at the start
        const t0 = W.elapsed;
        for (let i = 0; i < Math.round(0.25 * 30); i++) {
          s.input = { x: s.pos.x + fx * runSpeed / 30, z: s.pos.z + fz * runSpeed / 30, yaw: s.yaw, pitch: 0, mode: 'sprint', moving: true };
          m.input = { x: m.pos.x, z: m.pos.z, yaw: m.yaw, pitch: 0, mode: 'idle', moving: false };
          step(W, 1 / 30); W.events.length = 0; }
        m.actions.push({ a: 'attack', type: 'bite', el: W.elapsed - viewDelay });
        step(W, 1 / 30);
        const gap = Math.hypot(s.pos.x - m.pos.x, s.pos.z - m.pos.z);
        return { hit: !s.alive, gapNow: gap.toFixed(2) };
      } }
  }
}
console.log('Survivor sprinting away, Entity bites what it saw 0.2 s ago:');
console.log('  without lag compensation:', trial(false, 0.2, 5.9));
console.log('  with lag compensation:   ', trial(true, 0.2, 5.9));
console.log('Claimed view 2 s old (cheat / huge lag) is capped at', CONFIG.maxRewind, 's:', trial(true, 2.0, 5.9));
console.log('No delay claimed, survivor really out of range:', trial(true, 0, 5.9));
