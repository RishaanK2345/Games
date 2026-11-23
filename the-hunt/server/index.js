// Level 0: Hunt game server.  Run: npm run server   (port 2567, or $PORT on a host)
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './GameRoom.js';

const port = Number(process.env.PORT || 2567);
const server = new Server({ transport: new WebSocketTransport() });
server.define('level0', GameRoom).filterBy(['code']);   // same room code = same room
await server.listen(port);
console.log(`Level 0: Hunt server listening on ws://localhost:${port}`);
