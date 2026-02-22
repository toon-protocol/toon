#!/usr/bin/env node
import WebSocket from 'ws';

const RELAY_URL = 'ws://localhost:7100';
console.log('🔍 Verifying NIP-34 events...\n');

const ws = new WebSocket(RELAY_URL);
let eventCount = 0;

ws.on('open', () => {
  console.log('✅ Connected to:', RELAY_URL);
  ws.send(JSON.stringify(['REQ', 'nip34', { kinds: [30617, 1617, 1621], limit: 10 }]));
  setTimeout(() => ws.close(), 3000);
});

ws.on('message', (data) => {
  const [type, ...rest] = JSON.parse(data);
  if (type === 'EVENT') {
    const event = rest[1];
    eventCount++;
    console.log(`📄 Event ${eventCount}: kind:${event.kind}, id:${event.id.slice(0,16)}...`);
  } else if (type === 'EOSE') {
    console.log(`\n✅ Found ${eventCount} NIP-34 events`);
  }
});

ws.on('close', () => console.log('🔌 Done'));
ws.on('error', (e) => console.error('❌ Error:', e.message));
