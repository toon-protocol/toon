---
'@toon-protocol/core': patch
---

Remove the optional `@toon-protocol/connector` peer dependency. Core never imported it, and the TypeScript connector no longer ships. `@toon-protocol/sdk` is no longer in this repo; its last published version stays on npm.
