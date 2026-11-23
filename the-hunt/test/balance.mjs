// Bot-vs-bot balance check, no browser needed.
//   npm run balance            -> 20 rounds on a medium map
//   npm run balance -- 50 20   -> 50 rounds on a large map (sizes: 12, 16, 20)
// Edit shared/config.js, run this again, compare the win rates.
import { createRound, step, pickEntity } from '../shared/sim.js';

const rounds = Number(process.argv[2] || 20), size = Number(process.argv[3] || 16);
const roster = ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, human: false }));
const wins = { monster: 0, survivors: 0 }; let survived = 0, length = 0;
for (let i = 0; i < rounds; i++) {
  const seed = String(100000 + i * 7919);
  const W = createRound({ seed, size, anomalies: true, roster, entity: pickEntity(seed, 5, -1) });
  while (!W.over) { step(W, 1 / 30); W.events.length = 0; }
  wins[W.winner]++; survived += W.survivors.filter(s => s.alive).length; length += W.elapsed;
}
const pct = n => Math.round(n / rounds * 100) + '%';
console.log(`${rounds} rounds, ${size}x${size} map`);
console.log(`Survivors win ${pct(wins.survivors)}  ·  Entity wins ${pct(wins.monster)}`);
console.log(`Average survivors alive at the end: ${(survived / rounds).toFixed(1)} of 4  ·  average round ${Math.round(length / rounds)}s`);
