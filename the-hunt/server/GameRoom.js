// One Level 0 room: the lobby (names, ready, host controls) and, once everyone
// is ready, the round itself. The round runs on shared/sim.js, the same file
// the browser uses offline, so the rules can never drift apart.
import { Room } from '@colyseus/core';
import { createRound, step, snapshot, pickEntity, roundSeed } from '../shared/sim.js';
import { botNames, cleanName, GAME_VERSION } from '../shared/roster.js';

const TICK = 1 / 30;          // simulation rate (30 times a second)
const SNAP_EVERY = 0.05;      // positions to clients 20 times a second
const ACTIVE = new Map();     // room code -> room (one room per code)

export class GameRoom extends Room {
  maxClients = 6;

  onCreate(o) {
    const code = String(o.code || '').replace(/\D/g, '').slice(0, 9);
    if (!code) throw new Error('Missing room code');
    if (ACTIVE.has(code)) throw new Error('That room is full');   // the existing room with this code is full
    ACTIVE.set(code, this); this.code = code;
    this.phase = 'lobby';
    this.humans = [];         // [{sid, name, ready, host}] in join order
    this.settings = { size: [12, 16, 20].includes(+o.size) ? +o.size : 16, anomalies: o.anomalies !== false, bots: true, entity: 'random' };
    this.countdown = -1; this.W = null; this.snapT = 0; this.round = 0; this.lastEntity = null;

    const host = c => this.humans.find(h => h.sid === c.sessionId && h.host);
    this.onMessage('ready', (c, on) => { const h = this.humans.find(h => h.sid === c.sessionId); if (h && this.phase === 'lobby') { h.ready = !!on; this.sendLobby(); } });
    this.onMessage('entity', (c, key) => { if (!host(c) || this.phase !== 'lobby') return;
      const k = this.slots().some(q => q.key === key) ? key : 'random'; if (k === this.settings.entity) return;
      this.settings.entity = k; this.unreadyAll(); this.sendLobby(); });
    this.onMessage('bots', (c, on) => { if (!host(c) || this.phase !== 'lobby') return;
      this.settings.bots = !!on; if (!this.settings.bots && String(this.settings.entity).startsWith('bot:')) this.settings.entity = 'random';
      this.unreadyAll(); this.sendLobby(); });
    this.onMessage('hello', () => this.sendLobby());   // a client is listening now: (re)send the lobby
    this.onMessage('anomalies', (c, on) => { if (!host(c) || this.phase !== 'lobby' || this.settings.anomalies === !!on) return;
      this.settings.anomalies = !!on; this.unreadyAll(); this.sendLobby(); });
    // in a round: the latest input per player, and one-off actions (E, attacks, ability)
    this.onMessage('input', (c, inp) => { const a = this.agentOf(c); if (a && inp && typeof inp === 'object') a.input = inp; });
    this.onMessage('act', (c, act) => { const a = this.agentOf(c); if (a && act && a.actions.length < 8) a.actions.push(act); });

    this.setSimulationInterval(ms => this.tick(ms / 1000), TICK * 1000);
  }

  onJoin(c, o) {
    if ((o && o.v) !== GAME_VERSION) throw new Error('VERSION: the game was updated, refresh the page');
    if (this.phase !== 'lobby') throw new Error('A round is already in progress in this room');
    this.humans.push({ sid: c.sessionId, name: cleanName(o && o.name), ready: false, host: this.humans.length === 0 });
    this.sendLobby();
  }

  onLeave(c) {
    const i = this.humans.findIndex(h => h.sid === c.sessionId); if (i < 0) return;
    const [h] = this.humans.splice(i, 1);
    if (h.host && this.humans.length) this.humans[0].host = true;   // next player in becomes host
    if (this.settings.entity === h.sid) this.settings.entity = 'random';
    // mid-round: a bot takes over their character so the round can finish
    const a = this.agentOf(c);
    if (a && this.W && !this.W.over) { a.human = false; a.pid = null; a.input = null; a.actions = []; a.path = []; a.think = 0; a.state = a.isMonster ? 'patrol' : 'wander';
      this.broadcast('ev', [{ t: 'left', id: a.id, name: h.name }]); }
    this.sendLobby();
  }

  onDispose() { if (ACTIVE.get(this.code) === this) ACTIVE.delete(this.code); }

  /* ---------- lobby ---------- */
  slots() {   // humans in join order, then bots to fill 6 (if AI is on)
    const out = this.humans.map(h => ({ key: h.sid, name: h.name, host: h.host, ready: h.ready, bot: false }));
    if (this.settings.bots) botNames(this.code, this.humans.map(h => h.name)).slice(0, 6 - out.length)
      .forEach((n, i) => out.push({ key: 'bot:' + i, name: n, host: false, ready: true, bot: true }));
    return out;
  }
  unreadyAll() { for (const h of this.humans) h.ready = false; this.countdown = -1; }
  sendLobby() {
    const players = this.slots(), e = players.findIndex(q => q.key === this.settings.entity);
    this.broadcast('lobby', { code: this.code, size: this.settings.size, anomalies: this.settings.anomalies, bots: this.settings.bots,
      entity: e, countdown: this.countdown < 0 ? -1 : Math.ceil(this.countdown), players });
  }
  startRound() {
    const players = this.slots();
    const roster = players.map(q => ({ name: q.name, human: !q.bot, pid: q.bot ? null : q.key }));
    const chosen = players.findIndex(q => q.key === this.settings.entity);
    this.round++; const seed = roundSeed(this.code, this.round);
    const entity = pickEntity(seed, roster.length, chosen, players.findIndex(q => q.key === this.lastEntity));
    this.lastEntity = players[entity] ? players[entity].key : null;
    const opts = { seed, size: this.settings.size, anomalies: this.settings.anomalies, roster, entity };
    this.W = createRound(opts); this.W.lagComp = true; this.phase = 'playing'; this.countdown = -1; this.snapT = 0;
    this.broadcast('start', opts);   // every client builds the identical round from these options
  }
  agentOf(c) { if (!this.W || this.phase !== 'playing') return null; const W = this.W; return [W.monster, ...W.survivors].find(a => a.pid === c.sessionId) || null; }

  /* ---------- 30 Hz ---------- */
  tick(dt) {
    if (this.phase === 'lobby') {
      const all = this.humans.length > 0 && this.humans.every(h => h.ready);
      if (all && this.countdown < 0) { this.countdown = 3; this.sendLobby(); }
      else if (!all && this.countdown >= 0) { this.countdown = -1; this.sendLobby(); }
      else if (this.countdown >= 0) { const before = Math.ceil(this.countdown); this.countdown -= dt;
        if (this.countdown <= 0) this.startRound(); else if (Math.ceil(this.countdown) !== before) this.sendLobby(); }
      return;
    }
    const W = this.W; if (!W) return;
    step(W, TICK);
    if (W.events.length) { this.broadcast('ev', W.events.splice(0)); }
    for (const a of [W.monster, ...W.survivors]) if (a.human && a.corrected) {   // moved too fast or through a wall: put them back
      a.corrected = false; const c = this.clients.find(c => c.sessionId === a.pid); if (c) c.send('fix', { x: a.pos.x, z: a.pos.z }); }
    this.snapT -= TICK; if (this.snapT <= 0) { this.snapT = SNAP_EVERY; this.broadcast('s', snapshot(W)); }
    if (W.over) { this.broadcast('s', snapshot(W)); this.phase = 'lobby'; this.W = null; this.unreadyAll(); this.sendLobby(); }
  }
}

