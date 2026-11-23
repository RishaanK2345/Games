// Player names for bots and the game version (shared by client and server)
import { makeRng } from './rng.js';

/** bump this whenever the client and server must match; old tabs get told to refresh */
export const GAME_VERSION = 14;

export const BOT_NAMES = ['Marlow', 'Juniper', 'Okafor', 'Vasquez', 'Lindqvist', 'Tamsin', 'Ruiz', 'Hollis', 'Petrova', 'Nakamura', 'Briggs', 'Adeyemi', 'Sato', 'Kowalski', 'Fenwick', 'Delacroix', 'Moreau', 'Achebe', 'Halloran', 'Ivers'];

/** 5 bot names picked from the room seed, never clashing with the given names */
export function botNames(seed, taken = []) {
  const low = taken.map(n => String(n).toLowerCase());
  const r = makeRng(seed + '#names'), pool = BOT_NAMES.filter(n => !low.includes(n.toLowerCase())), out = [];
  for (let i = 0; i < 5; i++) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
}

/** usernames: trimmed, no markup, max 16 characters */
export const cleanName = n => String(n || '').replace(/[<>&"]/g, '').trim().slice(0, 16) || 'Wanderer';
