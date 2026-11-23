// Connection to the game server (Colyseus).
//
// Which server: ?server=wss://... in the URL wins, then VITE_SERVER_URL set at
// build time (see README), then a local server on port 2567 when you're
// running on localhost. Empty means "no server": online mode is disabled.
import { Client } from '@colyseus/sdk';

const q = new URLSearchParams(location.search);
export const SERVER_URL = q.get('server') || import.meta.env.VITE_SERVER_URL ||
  (['localhost', '127.0.0.1'].includes(location.hostname) ? `ws://${location.hostname}:2567` : '');

let client = null;

/** join the room with this code, or create it if nobody has */
export async function joinRoom(code, opts) {
  if (!SERVER_URL) throw new Error('No game server is set up for this site yet.');
  client = client || new Client(SERVER_URL);
  return client.joinOrCreate('level0', { code, ...opts });
}
