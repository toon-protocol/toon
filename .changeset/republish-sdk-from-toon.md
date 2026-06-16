---
"@toon-protocol/sdk": patch
---

Re-publish `@toon-protocol/sdk` from the standalone `toon` repository. This repairs the unresolved `workspace:*` dependency on `@toon-protocol/core` that made `@toon-protocol/sdk@0.5.0` uninstallable for external consumers — changesets/pnpm rewrite the workspace protocol to the real version (`@toon-protocol/core@1.4.1`) at publish time.
