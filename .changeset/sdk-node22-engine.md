---
"@toon-protocol/sdk": major
---

Drop Node 20 support: bump `engines.node` from `>=20` to `>=22` to match the CI test matrix (both `ci.yml` and `release.yml` now only run on Node 22). Consumers pinned to Node 20 are no longer covered by CI and should upgrade.
