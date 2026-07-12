---
'@toon-protocol/core': minor
'@toon-protocol/sdk': minor
---

Plumb per-packet `expiresAt` end-to-end (issue #81, rolling-swap prereq).

`buildIlpPrepare()` no longer silently drops a caller-supplied `expiresAt`: it is
now propagated onto the produced PREPARE as an ISO 8601 `expiresAt` string (the
field the connector's `POST /admin/ilp/send` already accepts). All `IlpClient`
transports forward it — the HTTP clients include it in the request body and the
direct client parses it into the `Date` handed to `ConnectorNode.sendPacket()`.
When omitted, behavior is unchanged (transport-derived / now+30s default).

`streamSwap()` gains `packetExpiryMs`: when set, each packet is sent with
`expiresAt = now + packetExpiryMs` (computed at send time) through
`wrapSwapPacketToToon()` and `StreamSwapClient.sendSwapPacket()`, so a stalled
packet expires deterministically and releases its in-flight slot. Omitted =
previous timeout-derived behavior.
