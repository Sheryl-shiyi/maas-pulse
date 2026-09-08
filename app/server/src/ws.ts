import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { ServerEvent, ClientEvent } from './types.js';

let wss: WebSocketServer;
let onClientMessage: ((event: ClientEvent) => void) | null = null;
let onClientConnect: ((ws: WebSocket) => void) | null = null;

export function initWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    console.log(`[ws] client connected (total: ${wss.clients.size})`);

    onClientConnect?.(ws);

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as ClientEvent;
        onClientMessage?.(event);
      } catch {
        console.error('[ws] invalid message received');
      }
    });

    ws.on('close', () => {
      console.log(`[ws] client disconnected (total: ${wss.clients.size})`);
    });
  });

  console.log('[ws] WebSocket server initialized on /ws');
}

export function broadcast(event: ServerEvent) {
  if (!wss) return;
  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function setClientMessageHandler(handler: (event: ClientEvent) => void) {
  onClientMessage = handler;
}

export function setClientConnectHandler(handler: (ws: WebSocket) => void) {
  onClientConnect = handler;
}

export function sendTo(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}
