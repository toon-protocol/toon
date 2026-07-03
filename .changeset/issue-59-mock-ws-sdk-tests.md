---
---

Mock the `ws` transport in SDK/core unit suites that call `node.start()` so BootstrapService's genesis-peer handshake no longer dials the live devnet relay, fixing flaky test timeouts (#59).
