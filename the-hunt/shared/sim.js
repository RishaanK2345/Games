// The round itself: bots, movement checks, attacks, vents, sanity, blackouts,
// mimic, timer and the win check. Pure game logic, no graphics or sound.
// Offline, the browser runs this. Online, the server runs this exact file.
//
// It never plays a sound or touches the screen. Anything the players should
// see or hear is pushed to round.events (e.g. {t:'attack',type:'bite'}) and
// the client turns those into sound, animation and HUD messages.

import { CONFIG, resetConfig } from './config.js';
import { makeRng, clamp, dist2 } from './rng.js';
import { generateMap, bfs, pathFrom } from './mapgen.js';
import { MAP, setWorld, BOXES, cellOf, pointBlocked, collide, los } from './physics.js';
import { pickAnomaly } from './anomalies.js';

export const ENTITY_ID = 100;   // survivors are 0..4
let G = null;                    // the round being simulated right now

/** Point the sim (and collision) at a round before stepping it. Several rooms can share one server. */
export function bindRound(W) {
  G = W;
  if (W) { Object.assign(CONFIG, W.config); setWorld(W.map, W.boxes); }
}
function emit(e) { G.events.push(e); }

export const fmt = t => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
export const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
export function turnToward(a, target, amt) { const d = angDiff(a.yaw, target); a.yaw += clamp(d, -amt, amt); }
export const speedOf = mode => mode === 'sprint' ? CONFIG.sprintSpeed : mode === 'walk' ? CONFIG.walkSpeed : mode === 'crouch' ? CONFIG.crouchSpeed : 0;

/* =====================================================================
   SETUP
   ===================================================================== */
export function newAgent(o) {
  return Object.assign({ pos: { x: 0, z: 0 }, yaw: 0, pitch: 0, radius: 0.35, alive: true, stamina: 1, exhausted: false, sanity: 0, inVent: null, ventCD: 0,
    mode: 'idle', moving: false, crouching: false, lean: 0, leanOff: 0, stepPhase: 0, stepT: 0, path: [], think: 0, state: 'wander', fleeT: 0, stuckT: 0,
    lastPos: { x: 0, z: 0 }, human: false, pid: null, input: null, actions: [], budget: 0 }, o);
}

/** Which roster slot plays the Entity: the host's choice, or random from the room seed. */
export function pickEntity(seed, rosterLen, choice) {
  if (choice != null && choice >= 0 && choice < rosterLen) return choice;
  return Math.floor(makeRng(seed + '#roles')() * rosterLen);
}

function placeVents(map, rnd) {
  const { N, S, h, v } = map, T = CONFIG.wallThick, cand = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x < N; x++) if (h[y][x]) { if (y > 0) cand.push({ px: (x + 0.5) * S, pz: y * S, nx: 0, nz: -1 }); if (y < N) cand.push({ px: (x + 0.5) * S, pz: y * S, nx: 0, nz: 1 }); }
  for (let y = 0; y < N; y++) for (let x = 0; x <= N; x++) if (v[y][x]) { if (x > 0) cand.push({ px: x * S, pz: (y + 0.5) * S, nx: -1, nz: 0 }); if (x < N) cand.push({ px: x * S, pz: (y + 0.5) * S, nx: 1, nz: 0 }); }
  const want = Math.max(3, Math.round(N * N * CONFIG.ventDensity)), vents = [];
  while (vents.length < want && cand.length) {
    const c = cand.splice(Math.floor(rnd() * cand.length), 1)[0];
    if (vents.some(o => Math.hypot(o.px - c.px, o.pz - c.pz) < S * 3)) continue;     // spread them out
    const vent = { ...c, id: vents.length, occupant: null, broken: false, ejectT: 0 };
    vent.face = { x: c.px + c.nx * (T / 2 + 0.15), z: c.pz + c.nz * (T / 2 + 0.15) };
    vent.front = { x: c.px + c.nx * (T / 2 + 0.5), z: c.pz + c.nz * (T / 2 + 0.5) };
    vent.cam = { x: c.px - c.nx * 0.02, z: c.pz - c.nz * 0.02 };
    vent.yawOut = Math.atan2(-c.nx, -c.nz);
    vents.push(vent);
  }
  return vents;
}

/**
 * Build a round. Everyone who builds it from the same options gets the exact
 * same map, vents and spawn points, so online only the options are sent.
 *   o = { seed, size, anomalies, roster:[{name, human, pid}], entity: roster index or -1 for nobody }
 * Survivors are the roster minus the Entity, in roster order (ids 0..n-1).
 */
export function createRound(o) {
  resetConfig(o.size);
  const anomaly = pickAnomaly(o.seed, o.anomalies !== false); if (anomaly.apply) anomaly.apply(CONFIG);
  const map = generateMap(o.seed); setWorld(map);
  const rnd = map.rnd, N = map.N, S = map.S;
  const ent = o.entity, roster = o.roster;
  // spawns: survivors near a random cell, Entity at the farthest reachable cell
  const sx = Math.floor(rnd() * N), sy = Math.floor(rnd() * N), from = bfs(map, sx, sy);
  let far = 0; for (let c = 1; c < N * N; c++) if (from.dist[c] > from.dist[far]) far = c;
  const near = []; for (let c = 0; c < N * N; c++) if (from.dist[c] >= 0 && from.dist[c] <= 2) near.push(c);
  const cc = c => ({ x: (c % N + 0.5) * S, z: (((c / N) | 0) + 0.5) * S });
  const survivors = [], survRoster = roster.filter((q, i) => i !== ent);
  for (let k = 0; k < survRoster.length; k++) {
    const q = survRoster[k], c = near[Math.floor(rnd() * near.length)], p = cc(c);
    const s = newAgent({ id: k, name: q.name, human: !!q.human, pid: q.pid || null, pos: { x: p.x + (rnd() - 0.5) * 1.6, z: p.z + (rnd() - 0.5) * 1.6 }, yaw: rnd() * 6.28 });
    s.think = rnd() * 2; survivors.push(s);
  }
  const mp = cc(far), eq = ent >= 0 ? roster[ent] : null;
  const botAbility = makeRng(o.seed + '#ability')() < 0.5 ? 'dash' : 'mimic';
  const monster = newAgent({ id: ENTITY_ID, name: eq ? eq.name : 'The Entity', human: !!(eq && eq.human), pid: eq ? eq.pid || null : null, isMonster: true,
    ability: eq && eq.human ? 'dash' : botAbility, disguised: false, revealT: 0, mimicCD: 0, burstT: 0, burstCD: 0, biteCD: 0, swipeCD: 0, ripCD: 0, ripT: 0, atkLock: 0,
    visit: new Float32Array(N * N).fill(-60), pos: { ...mp }, radius: 0.4, state: 'patrol', cooldown: 0, perceiveT: 0, repathT: 0, infoT: 0, goal: null, target: null,
    sees: false, seen: [], seenT: 0, frozen: true });
  if (survivors.length) monster.yaw = Math.atan2(-(survivors[0].pos.x - mp.x), -(survivors[0].pos.z - mp.z));
  if (!eq) { monster.absent = true; monster.pos = { x: -9999, z: -9999 }; }   // AI off and nobody plays the Entity
  const vents = placeVents(map, rnd);
  for (const s of survivors) if (s.human) s.yaw = Math.atan2(-(mp.x - s.pos.x), -(mp.z - s.pos.z)) + Math.PI;   // face away from where it's coming from
  const W = { seed: o.seed, size: o.size, map, boxes: BOXES, config: JSON.parse(JSON.stringify(CONFIG)), anomaly, survivors, monster, vents,
    blackouts: [], nextBlackout: 0, boRng: makeRng(o.seed + '#blackouts'), evRng: makeRng(o.seed + '#events'),
    timeLeft: CONFIG.roundTime, elapsed: 0, over: false, winner: null, events: [] };
  W.nextBlackout = CONFIG.freezeTime + 12 + W.boRng() * 15;
  G = W;
  return W;
}
export const agentById = (W, id) => id === ENTITY_ID ? W.monster : W.survivors.find(s => s.id === id);

/* =====================================================================
   ONE SIM TICK
   ===================================================================== */
export function step(W, dt) {
  bindRound(W); if (W.over) return;
  W.elapsed += dt; W.timeLeft -= dt;
  const m = W.monster; const wasFrozen = m.frozen; m.frozen = W.elapsed < CONFIG.freezeTime;
  if (wasFrozen && !m.frozen) emit({ t: 'unfreeze', ab: m.ability });
  updateMimic(m, dt); m.cooldown = Math.max(0, m.cooldown - dt); m.biteCD = Math.max(0, m.biteCD - dt); m.ripCD = Math.max(0, m.ripCD - dt); m.ripT = Math.max(0, m.ripT - dt);
  m.atkLock = Math.max(0, m.atkLock - dt); m.swipeCD = Math.max(0, m.swipeCD - dt); updateBurst(m, dt);
  // real players: apply what they sent (movement is checked, not trusted)
  for (const a of [m, ...W.survivors]) if (a.human) {
    if (a.input) applyHuman(a, a.input, dt);
    while (a.actions.length) doAction(a, a.actions.shift());
  }
  for (const s of W.survivors) if (s.alive && !s.human) updateBotSurvivor(s, dt);
  if (!m.human && !m.absent) updateMonsterBot(m, dt);
  if (!m.absent && !m.frozen) { m.seenT -= dt; if (m.seenT <= 0) { m.seenT = 0.1; m.seen = W.survivors.filter(s => s.alive && !s.inVent && canSee(m, s)).map(s => s.id); } }
  updateSanity(dt); updateVentRips(dt); updateBlackouts(dt);
  // win check
  const alive = W.survivors.filter(s => s.alive).length;
  if (alive === 0 && W.survivors.length) endRound('monster'); else if (W.timeLeft <= 0) endRound('survivors');
}
function endRound(winner) { G.over = true; G.winner = winner; emit({ t: 'end', winner, time: fmt(CONFIG.roundTime - Math.max(0, G.timeLeft)) }); }

/* =====================================================================
   REAL PLAYERS: inputs and actions
   input = {x,z,yaw,pitch,mode,moving,crouch,lean,leanOff}
   ===================================================================== */
export function updateStamina(s, dt) {
  if (s.exhausted) { s.exhaustT -= dt; s.stamina = Math.min(1, 1 - s.exhaustT / CONFIG.exhaustCooldown); if (s.exhaustT <= 0) { s.exhausted = false; s.stamina = 1; } return; }
  if (s.mode === 'sprint') { s.stamina -= dt / CONFIG.sprintTime; if (s.stamina <= 0) { s.stamina = 0; s.exhausted = true; s.exhaustT = CONFIG.exhaustCooldown; } }
  else s.stamina = Math.min(1, s.stamina + CONFIG.staminaRegen * dt);
}
function applyHuman(a, inp, dt) {
  if (!a.alive) return;
  a.yaw = +inp.yaw || 0; a.pitch = clamp(+inp.pitch || 0, -1.35, 1.35); a.lean = clamp(+inp.lean || 0, -1, 1); a.leanOff = clamp(+inp.leanOff || 0, -0.6, 0.6);
  const stuck = a.inVent || a.jumpT != null || (a.isMonster && (a.frozen || a.ripT > 0));
  if (stuck) { a.moving = false; a.mode = 'idle'; a.crouching = false; a.budget = 0; if (!a.isMonster) updateStamina(a, dt); return; }
  a.crouching = !!inp.crouch;
  let speed, mode = inp.moving ? inp.mode : 'idle';
  if (!['idle', 'crouch', 'walk', 'sprint'].includes(mode)) mode = 'walk';
  if (a.isMonster) { speed = entitySpeed(a) * (a.crouching ? CONFIG.entityCrouchSpeed : 1); if (mode !== 'idle') mode = a.crouching ? 'crouch' : 'walk'; }
  else { if (mode === 'sprint' && (a.exhausted || a.stamina <= 0)) mode = 'walk'; speed = speedOf(mode); }
  // movement budget: what this player could have covered at their allowed speed (+25% for network jitter)
  a.budget = Math.min((a.budget || 0) + speed * dt * 1.25, 0.9 + speed * 0.12);
  const tx = +inp.x, tz = +inp.z;
  if (isFinite(tx) && isFinite(tz)) {
    const dx = tx - a.pos.x, dz = tz - a.pos.z, d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      const st = Math.min(d, a.budget); a.pos.x += dx / d * st; a.pos.z += dz / d * st; collide(a.pos, a.radius); a.budget -= st;
      if (d - st > 0.75 || Math.hypot(a.pos.x - tx, a.pos.z - tz) > 0.75) a.corrected = true;   // too fast or through a wall: snap them back
    }
  }
  a.mode = mode; a.moving = mode !== 'idle';
  if (!a.isMonster) updateStamina(a, dt);
}
/** action = {a:'use'} | {a:'attack',type:'bite'|'swipe'} | {a:'ability'} | {a:'pick',ab:'dash'|'mimic'} */
function doAction(a, act) {
  if (G.over || !a.alive || !act) return;
  if (act.a === 'use') useAction(a);
  else if (a.isMonster && act.a === 'attack' && (act.type === 'bite' || act.type === 'swipe')) entityAttack(a, act.type);
  else if (a.isMonster && act.a === 'ability') useAbility(a);
  else if (a.isMonster && act.a === 'pick' && a.frozen && (act.ab === 'dash' || act.ab === 'mimic')) { a.ability = act.ab; emit({ t: 'ability', ab: act.ab }); }
}
/** the vent this agent can use right now (same rules as the on-screen prompt) */
export function usableVent(a) {
  const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw); let best = null, bd = 1e9;
  for (const v of G.vents) {
    if (v.broken) continue;
    if (a.isMonster ? a.disguised : (v.occupant || a.ventCD > 0)) continue;
    const dx = v.face.x - a.pos.x, dz = v.face.z - a.pos.z, d = Math.hypot(dx, dz);
    if (d > 1.5 || d >= bd) continue;
    if (d > 0.2 && (dx * fx + dz * fz) / d < 0.35) continue;          // must roughly face it
    best = v; bd = d;
  }
  return best;
}
function useAction(a) {
  if (a.jumpT != null) return;
  if (a.inVent) { exitVent(a); return; }
  const v = usableVent(a); if (!v) return;
  if (a.isMonster) ripVent(a, v); else enterVent(a, v);
}

/* =====================================================================
   SHARED HELPERS
   ===================================================================== */
export function isWet(pos) { if (!MAP || !MAP.wet) return false; const [cx, cy] = cellOf(pos); return MAP.wet.has(cx + cy * MAP.N); }
export function noiseRadius(s) { if (!s.alive || !s.moving || s.inVent) return 0; const w = isWet(s.pos);
  if (s.mode === 'sprint') return CONFIG.hearSprint * (w ? 1.3 : 1); if (s.mode === 'walk') return CONFIG.hearWalk * (w ? 2 : 1); return w ? 5 : 0; }
function followPath(a, speed, dt) {
  if (!a.path.length || speed <= 0) return false;
  while (a.path.length > 1 && los(a.pos.x, a.pos.z, a.path[1].x, a.path[1].z, a.radius * 0.95)) a.path.shift();
  const wp = a.path[0]; let dx = wp.x - a.pos.x, dz = wp.z - a.pos.z; const d = Math.hypot(dx, dz);
  if (d < 0.35) { a.path.shift(); return a.path.length > 0; }
  dx /= d; dz /= d; const st = Math.min(d, speed * dt); a.pos.x += dx * st; a.pos.z += dz * st; collide(a.pos, a.radius);
  turnToward(a, Math.atan2(-dx, -dz), dt * 7); return true;
}
function pathToPoint(a, pt) {
  const [sx, sy] = cellOf(a.pos), [tx, ty] = cellOf(pt); const res = bfs(MAP, sx, sy);
  const path = pathFrom(MAP, res, sx, sy, tx + ty * MAP.N); path.push({ x: pt.x, z: pt.z }); return path;
}
export function blackoutAt(x, z) { for (const b of G.blackouts) if (Math.hypot(x - b.x, z - b.z) < b.r) return b; return null; }
export function isDark(p) { const b = blackoutAt(p.x, p.z); return !!(b && b.t >= 1.4 && b.t < b.dur); }   // fully out (after the warning flicker)

/* =====================================================================
   BOT SURVIVOR AI  (fills empty slots)
   ===================================================================== */
function wanderPath(s) {
  // prefer spots away from the other survivors so the group spreads out
  const [sx, sy] = cellOf(s.pos), res = bfs(MAP, sx, sy), N = MAP.N, others = G.survivors.filter(o => o !== s && o.alive).map(o => cellOf(o.pos));
  let best = -1, bs = -1e9;
  for (let i = 0; i < res.dist.length; i++) { const d = res.dist[i]; if (d < 3 || d > 10) continue;
    const x = i % N, y = (i / N) | 0; let near = 99; for (const [ox, oy] of others) near = Math.min(near, Math.abs(ox - x) + Math.abs(oy - y));
    const sc = Math.min(near, 6) * 1.2 + Math.random() * 4; if (sc > bs) { bs = sc; best = i; } }
  return best < 0 ? [] : pathFrom(MAP, res, sx, sy, best);
}
function fleePath(s) {
  const m = G.monster, N = MAP.N; const [mx, my] = cellOf(m.pos), [sx, sy] = cellOf(s.pos);
  const dm = bfs(MAP, mx, my).dist; const me = sx + sy * N;
  const mc = mx + my * N;
  for (const block of [n => n !== me && dm[n] <= 1, n => n === mc && n !== me, () => false]) {   // avoid the Entity's area; if boxed in, just avoid its exact cell
    const db = bfs(MAP, sx, sy, block); let best = -1, bs = -1e9;
    for (let c = 0; c < N * N; c++) { if (db.dist[c] <= 0 || db.dist[c] > 7) continue; const sc = dm[c] * 1.0 - db.dist[c] * 0.45 + Math.random() * 0.6; if (sc > bs) { bs = sc; best = c; } }
    if (best >= 0) return pathFrom(MAP, db, sx, sy, best);
  }
  return [];
}
function nearbyHideVent(s) {
  // a free vent that's close to us and not closer to the Entity than to us
  const m = G.monster; let best = null, bd = 1e9;
  for (const v of G.vents) { if (v.broken || v.occupant) continue; const d = dist2(s.pos, v.front); if (d > 9) continue;
    if (dist2(m.pos, v.front) < d + 2.5) continue; if ((s.botVentCD || 0) > 0) continue; if (d < bd) { bd = d; best = v; } }
  return best;
}
function updateBotSurvivor(s, dt) {
  const m = G.monster, dm = dist2(s.pos, m.pos);
  s.botVentCD = Math.max(0, (s.botVentCD || 0) - dt);
  if (s.inVent) {   // hiding: leave before the smilers come, or once things are quiet
    s.hideT = (s.hideT || 0) + dt; const near = !m.frozen && dm < 12;
    if (near) s.calmT = 0; else s.calmT = (s.calmT || 0) + dt;
    if (s.sanity >= CONFIG.ventWarn - 2 - (s.id % 3) * 0.7 || (s.hideT > 5 && s.calmT > 4)) { exitVent(s); s.botVentCD = 15; s.hideT = 0; s.state = near ? 'flee' : 'wander'; s.think = 0; }
    return;
  }
  const sightR = (isDark(s.pos) || isDark(m.pos)) ? CONFIG.darkVision : 16;
  const threat = !m.frozen && !m.disguised && (dm < 5 || (dm < sightR && los(s.pos.x, s.pos.z, m.pos.x, m.pos.z)));
  if (threat && s.state !== 'toVent') {
    // first reaction: is there a vent we can reach before it reaches us?
    const v = (dm > 4 && s.sanity < 4) ? nearbyHideVent(s) : null;
    if (v) { s.state = 'toVent'; s.ventGoal = v; s.path = pathToPoint(s, v.front); s.think = 3; }
    else { if (s.state !== 'flee') s.think = 0; s.state = 'flee'; s.fleeT = 4; }
  }
  else if (s.state === 'flee') { s.fleeT -= dt; if (s.fleeT <= 0) { s.state = 'wander'; s.think = 0; } }
  if (s.state === 'toVent') {
    const v = s.ventGoal;
    if (!v || v.broken || v.occupant || dist2(m.pos, v.front) < 1.5) { s.state = 'flee'; s.fleeT = 3; s.think = 0; }
    else if (dist2(s.pos, v.front) < 0.7) { enterVent(s, v); s.hideT = 0; s.calmT = 0; s.state = 'hiding'; return; }
  }
  s.think -= dt;
  if (s.state !== 'toVent' && (s.think <= 0 || (s.state === 'wander' && !s.path.length))) {
    if (s.state === 'flee') { s.path = fleePath(s); s.think = 0.5; }
    else if (s.state === 'idle') { s.state = 'wander'; s.path = wanderPath(s); s.think = 7 + Math.random() * 6; }
    else if (Math.random() < 0.3) { s.state = 'idle'; s.path = []; s.think = 2 + Math.random() * 4; }
    else { s.state = 'wander'; s.path = wanderPath(s); s.think = 7 + Math.random() * 6; }
  }
  // sprint in bursts so the bar never empties (unless it's right on top of us)
  let want = 'walk';
  if (s.state === 'flee' || s.state === 'toVent') {
    if (s.exhausted) want = 'walk';
    else if (dm < 6) want = 'sprint';
    else { if (s.stamina < 0.25) s.recover = true; else if (s.stamina > 0.6) s.recover = false; want = s.recover ? 'walk' : 'sprint'; }
  }
  else if (s.state === 'idle') want = 'idle';
  else if (!m.frozen && dm < 22) want = 'crouch';            // sneak when it's around
  const moved = followPath(s, speedOf(want), dt);
  s.mode = moved ? want : 'idle'; s.moving = moved; s.crouching = want === 'crouch';
  updateStamina(s, dt);
  // unstick
  s.stuckT += dt; if (s.stuckT > 1.2) { if (moved && dist2(s.pos, s.lastPos) < 0.3) s.think = 0; s.stuckT = 0; s.lastPos = { ...s.pos }; }
}

/* =====================================================================
   ENTITY AI (when no human plays it) + vision
   ===================================================================== */
export function canSee(m, s) {
  const pts = [s.pos];   // AI ignores a peeking head; leaning is still drawn so real players can spot it
  const cosFov = Math.cos(CONFIG.visionFov * Math.PI / 360);
  const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw); let range = CONFIG.visionRange * (s.mode === 'crouch' || s.mode === 'idle' ? 0.55 : 1);
  if (isDark(m.pos) || isDark(s.pos)) range = Math.min(range, CONFIG.darkVision);   // blackout: nobody sees far
  for (const q of pts) { const dd = Math.hypot(q.x - m.pos.x, q.z - m.pos.z);
    if (dd > range) continue;
    if (((q.x - m.pos.x) * fx + (q.z - m.pos.z) * fz) / dd >= cosFov && los(m.pos.x, m.pos.z, q.x, q.z)) return true; }
  return false;
}
function perceive(m) {
  let seen = null, sd = 1e9, heard = null, hd = 1e9;
  for (const s of G.survivors) { if (!s.alive || s.inVent) continue; const d = dist2(m.pos, s.pos);
    if (d < sd && canSee(m, s)) { seen = s; sd = d; }
    const nr = noiseRadius(s); if (nr >= d && d < hd) { heard = s; hd = d; } }
  if (seen) { if (m.lastSeen) { const dx = seen.pos.x - m.lastSeen.x, dz = seen.pos.z - m.lastSeen.z, d = Math.hypot(dx, dz); if (d > 0.05) m.predDir = { x: dx / d, z: dz / d }; } m.lastSeen = { x: seen.pos.x, z: seen.pos.z }; m.lostHandled = false; }
  if (seen) { m.state = 'chase'; m.target = seen; m.sees = true; m.goal = { x: seen.pos.x, z: seen.pos.z }; m.infoT = 0; m.path = []; return; }
  m.sees = false;
  if (m.state === 'chase' && !m.lostHandled && m.lastSeen) { m.lostHandled = true;   // just lost sight: cut them off where they were heading
    if (m.predDir) for (let k = 4; k >= 1; k--) { const px = m.lastSeen.x + m.predDir.x * k, pz = m.lastSeen.z + m.predDir.z * k; if (!pointBlocked(px, pz, 0.4) && los(m.lastSeen.x, m.lastSeen.z, px, pz, 0.3)) { m.goal = { x: px, z: pz }; m.repathT = 0; m.path = []; break; } } }
  if (heard) { const g = { x: heard.pos.x, z: heard.pos.z }; if (!m.goal || dist2(g, m.goal) > 2.5) { m.goal = g; m.repathT = 0; } if (m.state !== 'chase') m.state = 'investigate'; m.infoT = 0; return; }
  m.infoT += 0.1;
}
function patrolGoal(m) {   // go check the places it hasn't looked at in a while
  const [sx, sy] = cellOf(m.pos), res = bfs(MAP, sx, sy), N = MAP.N; let best = 0, bs = -1e9;
  for (let i = 0; i < res.dist.length; i++) { const d = res.dist[i]; if (d < 4) continue; const sc = Math.min(G.elapsed - m.visit[i], 90) - d * 0.8 + Math.random() * 12; if (sc > bs) { bs = sc; best = i; } }
  return { x: (best % N + 0.5) * MAP.S, z: (((best / N) | 0) + 0.5) * MAP.S };
}
function updateMonsterBot(m, dt) {
  if (m.frozen) return;
  const [cx, cy] = cellOf(m.pos); m.visit[cx + cy * MAP.N] = G.elapsed;
  m.perceiveT -= dt; if (m.perceiveT <= 0) { m.perceiveT = 0.1; perceive(m); }
  if (m.ripT > 0) { m.moving = false; return; }
  if (m.ability === 'mimic') {   // disguise while hunting; unveil when close to a survivor it can see
    if (!m.disguised && m.mimicCD <= 0 && m.revealT <= 0 && !m.sees) toggleMimic(m);
    else if (m.disguised && m.sees && m.target && dist2(m.pos, m.target.pos) < 2.4) toggleMimic(m); }
  if (m.ventWatch && (m.ventWatch.broken || m.sees)) { m.ventWatch = null; m.watchT = 0; }
  let speed = entitySpeed(m); let moved = false; m.crouching = false;
  if (m.state === 'chase' && m.sees && m.target && m.target.alive) {
    let dx = m.target.pos.x - m.pos.x, dz = m.target.pos.z - m.pos.z; const d = Math.hypot(dx, dz);
    if (d > 3 && d < 14 && m.target.mode === 'sprint' && entityBurst(m)) speed = entitySpeed(m);
    if (d > 0.05) { dx /= d; dz /= d; const st = Math.min(d, speed * dt); m.pos.x += dx * st; m.pos.z += dz * st; collide(m.pos, m.radius); turnToward(m, Math.atan2(-dx, -dz), dt * 9); moved = true; }
  } else if (m.ventWatch) {   // it saw someone climb into a vent: go rip it open (or wait for the cooldown)
    const v = m.ventWatch; m.state = 'investigate';
    if (dist2(m.pos, v.face) < 1.3) { turnToward(m, Math.atan2(-(v.face.x - m.pos.x), -(v.face.z - m.pos.z)), dt * 8); m.watchT = (m.watchT || 0) + dt;
      if (m.ripCD <= 0) ripVent(m, v); else if (m.watchT > 14) { m.ventWatch = null; m.watchT = 0; } }
    else { m.watchT = 0; m.repathT -= dt; if (!m.goal || dist2(m.goal, v.front) > 0.5 || m.repathT <= 0 || !m.path.length) { m.goal = { x: v.front.x, z: v.front.z }; m.path = pathToPoint(m, m.goal); m.repathT = 1.2; } moved = followPath(m, speed * 0.95, dt); }
  } else {
    if (m.state === 'patrol') speed *= 0.72;
    else if (m.state === 'investigate') { speed *= 0.9; if (m.goal && dist2(m.pos, m.goal) < 7) { m.crouching = true; speed *= CONFIG.entityCrouchSpeed; } }   // creeps up on noises
    if (!m.goal) { m.goal = patrolGoal(m); m.state = 'patrol'; m.repathT = 0; }
    m.repathT -= dt; if (m.repathT <= 0 || !m.path.length) { m.path = pathToPoint(m, m.goal); m.repathT = 1.2; }
    moved = followPath(m, speed, dt);
    if (dist2(m.pos, m.goal) < 0.8) {
      if (m.state !== 'patrol' && m.ripCD <= 0) { const v = G.vents.find(v => !v.broken && dist2(v.front, m.pos) < 4.5); if (v && Math.random() < 0.45) m.ventWatch = v; }   // lost them near a vent? check it
      m.goal = null; m.path = []; if (m.state !== 'patrol') { m.state = 'patrol'; m.yaw += Math.PI * 0.6; } }
  }
  m.moving = moved;
  if (m.biteCD <= 0 && attackTarget(m, 'bite')) entityAttack(m, 'bite'); else if (m.swipeCD <= 0 && attackTarget(m, 'swipe')) entityAttack(m, 'swipe');
}

/* =====================================================================
   ENTITY ABILITIES: dash or mimic, and the two attacks
   ===================================================================== */
export function entitySpeed(m) { if (m.ripT > 0) return 0; if (m.disguised) return m.crouching ? CONFIG.crouchSpeed / CONFIG.entityCrouchSpeed : CONFIG.mimicSpeed; return (m.burstT > 0 ? CONFIG.entityBurstSpeed : CONFIG.monsterSpeed) * (m.cooldown > 0 ? 0.45 : 1); }
function entityBurst(m) {
  if (m.ability !== 'dash' || m.disguised) return false;
  if (m.frozen || m.burstT > 0 || m.burstCD > 0 || m.cooldown > 0) return false;
  m.burstT = CONFIG.entityBurstTime; emit({ t: 'burst' }); return true;
}
function updateBurst(m, dt) {
  if (m.burstT > 0) { m.burstT -= dt; if (m.burstT <= 0) { m.burstT = 0; m.burstCD = CONFIG.entityBurstCooldown; } }
  else m.burstCD = Math.max(0, m.burstCD - dt);
}
function endBurst(m) { if (m.burstT > 0) { m.burstT = 0; m.burstCD = CONFIG.entityBurstCooldown; } }
function useAbility(m) { if (m.ability === 'mimic') toggleMimic(m); else entityBurst(m); }
function toggleMimic(m) {
  if (m.frozen || m.ripT > 0) return false;
  if (m.disguised) { m.disguised = false; m.revealT = CONFIG.revealTime; m.mimicCD = CONFIG.mimicCooldown; emit({ t: 'reveal' }); return true; }
  if (m.mimicCD > 0 || m.revealT > 0) return false;
  // borrow the look of a living survivor (their armband color)
  const alive = G.survivors.filter(s => s.alive); const who = alive.length ? alive[Math.floor(G.evRng() * alive.length)] : (G.survivors[0] || { id: Math.floor(G.evRng() * 5) });
  m.disguised = true; m.look = who.id; endBurst(m); emit({ t: 'disguise', look: who.id }); return true;
}
function updateMimic(m, dt) { if (m.revealT > 0) m.revealT = Math.max(0, m.revealT - dt); if (!m.disguised && m.revealT <= 0) m.mimicCD = Math.max(0, m.mimicCD - dt); }
function attackTarget(m, type) {
  const range = type === 'bite' ? CONFIG.biteRange : CONFIG.swipeRange, arc = type === 'bite' ? 0.45 : 0.1;
  const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw); let best = null, bd = 1e9;
  for (const s of G.survivors) { if (!s.alive || s.inVent) continue; const d = dist2(m.pos, s.pos); if (d > range) continue;
    const dot = ((s.pos.x - m.pos.x) * fx + (s.pos.z - m.pos.z) * fz) / Math.max(d, 0.01); if (dot < arc && d > 0.7) continue;
    if (!los(m.pos.x, m.pos.z, s.pos.x, s.pos.z)) continue; if (d < bd) { bd = d; best = s; } }
  return best;
}
function entityAttack(m, type) {
  if (m.frozen || G.over || m.atkLock > 0 || m.ripT > 0) return false;
  if (m.disguised) { toggleMimic(m); return false; }   // attacking unveils you first
  if (m.revealT > 0) return false;
  const key = type === 'bite' ? 'biteCD' : 'swipeCD'; if (m[key] > 0) return false;
  m[key] = type === 'bite' ? CONFIG.biteCooldown : CONFIG.swipeCooldown;           // cooldown applies on hit or miss
  m.atkSide = -(m.atkSide || 1);
  emit({ t: 'attack', type, side: m.atkSide });
  const s = attackTarget(m, type);
  if (s) { catchSurvivor(s); endBurst(m); m.cooldown = CONFIG.catchRecover; }
  return true;
}
function catchSurvivor(s, cause) {
  if (!s.alive) return;
  if (s.inVent) exitVent(s);
  s.alive = false; s.path = []; s.moving = false; s.jumpT = null;
  const ts = fmt(CONFIG.roundTime - G.timeLeft); s.caughtAt = ts + (cause === 'smilers' ? ' (smilers)' : '');
  emit({ t: 'caught', id: s.id, cause: cause || 'entity', at: ts, x: s.pos.x, z: s.pos.z, yaw: s.yaw, mode: s.mode });
}

/* =====================================================================
   VENTS + SANITY (smilers)
   ===================================================================== */
function enterVent(s, vent) {
  s.inVent = vent; vent.occupant = s; s.mode = 'idle'; s.moving = false;
  s.pos = { ...vent.front }; s.yaw = vent.yawOut; s.pitch = -0.05;
  emit({ t: 'ventIn', id: s.id, v: vent.id });
  const m = G.monster; if (m && !m.human && !m.frozen && ((m.sees && m.target === s) || canSee(m, s))) m.ventWatch = vent;
}
function exitVent(s) {
  const vent = s.inVent; if (!vent) return;
  vent.occupant = null; s.inVent = null; s.ventCD = 1; s.pos = { ...vent.front }; s.yaw = vent.yawOut; s.pitch = 0;
  emit({ t: 'ventOut', id: s.id, v: vent.id, x: s.pos.x, z: s.pos.z });
}
function ripVent(m, v) {
  if (m.ripCD > 0 || m.frozen || v.broken || m.ripT > 0) return false;
  m.ripCD = CONFIG.ripCooldown; m.ripT = CONFIG.ripRoot; m.atkLock = CONFIG.ripAttackLock;
  m.yaw = Math.atan2(-(v.face.x - m.pos.x), -(v.face.z - m.pos.z));
  v.broken = true; v.ejectT = v.occupant ? CONFIG.ripEjectDelay : 0;
  emit({ t: 'rip', v: v.id });
  if (!m.human) m.ventWatch = null;
  return true;
}
function updateVentRips(dt) {
  for (const v of G.vents) {
    if (v.ejectT > 0) { v.ejectT -= dt; if (v.ejectT <= 0 && v.occupant) { const s = v.occupant; exitVent(s);
      s.pos = { x: v.front.x + v.nx * 0.35, z: v.front.z + v.nz * 0.35 }; collide(s.pos, s.radius); s.ventCD = 3;
      emit({ t: 'eject', id: s.id, v: v.id, x: s.pos.x, z: s.pos.z });
      if (!s.human) { s.state = 'flee'; s.fleeT = 5; s.think = 0; s.recover = false; } } }
  }
}
function updateSanity(dt) {
  for (const s of G.survivors) {
    s.ventCD = Math.max(0, (s.ventCD || 0) - dt);
    if (s.inVent) s.sanity += dt; else s.sanity = Math.max(0, s.sanity - dt * CONFIG.sanityRecover);
    if (!s.alive || !s.inVent) continue;
    if (!s.human) { if (s.sanity >= CONFIG.ventDeath) catchSurvivor(s, 'smilers'); continue; }
    // a real player gets the smiler jumpscare first, then dies
    if (s.jumpT == null && s.sanity >= CONFIG.ventDeath) { s.jumpT = 0; emit({ t: 'smilers', id: s.id }); }
    else if (s.jumpT != null) { s.jumpT += dt; if (s.jumpT > 1.15) catchSurvivor(s, 'smilers'); }
  }
}

/* =====================================================================
   BLACKOUTS (seeded: the same for everyone in the room)
   ===================================================================== */
function updateBlackouts(dt) {
  if (G.monster.frozen) return;
  G.nextBlackout -= dt;
  const R = G.boRng;
  if (G.nextBlackout <= 0) { G.nextBlackout = CONFIG.blackoutMin + R() * (CONFIG.blackoutMax - CONFIG.blackoutMin);
    if (G.blackouts.length < (MAP.N >= 20 ? 2 : 1)) { const S = MAP.S, c = Math.floor(R() * MAP.N * MAP.N);
      const b = { x: (c % MAP.N + 0.5) * S, z: (((c / MAP.N) | 0) + 0.5) * S, r: CONFIG.blackoutRadius * S * (0.8 + R() * 0.4), t: 0, dur: 1.4 + CONFIG.blackoutDur[0] + R() * (CONFIG.blackoutDur[1] - CONFIG.blackoutDur[0]) };
      G.blackouts.push(b); emit({ t: 'power', x: b.x, z: b.z }); } }
  for (const b of G.blackouts) { const was = b.t < b.dur; b.t += dt; if (was && b.t >= b.dur) emit({ t: 'power', x: b.x, z: b.z, back: true }); }
  G.blackouts = G.blackouts.filter(b => b.t < b.dur + 0.9);
}

/* =====================================================================
   NETWORK SNAPSHOT (server -> clients, ~20 times a second)
   ===================================================================== */
const r2 = v => Math.round(v * 100) / 100;
export function snapshot(W) {
  const m = W.monster;
  return {
    tl: r2(W.timeLeft), el: r2(W.elapsed),
    s: W.survivors.map(s => [s.id, r2(s.pos.x), r2(s.pos.z), r2(s.yaw), r2(s.pitch), s.mode, s.moving ? 1 : 0, s.crouching ? 1 : 0, r2(s.leanOff || 0), s.alive ? 1 : 0,
      s.inVent ? s.inVent.id : -1, r2(s.stamina), s.exhausted ? 1 : 0, r2(s.sanity), r2(s.exhaustT || 0)]),
    m: { x: r2(m.pos.x), z: r2(m.pos.z), yaw: r2(m.yaw), pitch: r2(m.pitch), mode: m.mode, moving: m.moving ? 1 : 0, crouching: m.crouching ? 1 : 0, state: m.state,
      disguised: m.disguised ? 1 : 0, look: m.look, revealT: r2(m.revealT), burstT: r2(m.burstT), burstCD: r2(m.burstCD), mimicCD: r2(m.mimicCD), biteCD: r2(m.biteCD),
      swipeCD: r2(m.swipeCD), ripCD: r2(m.ripCD), ripT: r2(m.ripT), cooldown: r2(m.cooldown), atkLock: r2(m.atkLock), frozen: m.frozen ? 1 : 0, ability: m.ability, seen: m.seen },
    b: W.blackouts.map(b => [r2(b.x), r2(b.z), r2(b.r), r2(b.t), r2(b.dur)]),
  };
}

/** internals, for tests and the ?debug console only */
export const DEBUG = { catchSurvivor, toggleMimic, entityAttack, ripVent, enterVent, exitVent, perceive, updateBotSurvivor, updateMonsterBot, useAbility, attackTarget, entityBurst };
