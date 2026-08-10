---
"@toon-protocol/core": minor
---

feat(core): add an optional `notice` field to `IlpPeerInfo` (kind:10032)

`IlpPeerInfo` gains an optional
`notice?: { id, severity: 'info' | 'action-required', summary, url }` field
(toon#183), giving operators a delivery channel for status/breaking-change
notices through the one event every client already fetches at bootstrap.
`buildIlpPeerInfoEvent` emits it when present and omits it otherwise; the
parser drops a malformed or partial notice while still parsing the rest of
`IlpPeerInfo`, and degrades an unrecognized `severity` to `'info'` rather
than rejecting it.

This is additive and optional — no behaviour change for a consumer that does
not use the field.
