---
'@toon-protocol/sdk': minor
---

Add `createAppIntake`: a web-standard `fetch` handler that serves a connector's delivery to an app (parse `{ event }`, check the signature, dispatch on kind, map the answer to a wire code and status). It reads the stated payment from `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain` and checks no price or payload limit.
