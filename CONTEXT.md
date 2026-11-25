# TOON library layer

Terms specific to this repo. **App**, **connector** and **greeting** are defined in the connector's `CONTEXT.md` (toon-protocol/connector).

## App intake

The module in `@toon-protocol/sdk` (`createAppIntake`) that serves a connector's delivery to an **app**. It parses the body as `{ event }`, checks the event's signature (integrity only; dev mode skips it), runs the handler for the event's kind with the payment the connector stated in `X-TOON-Payer`, `X-TOON-Amount` and `X-TOON-Chain`, and maps the handler's answer to a wire code and HTTP status. It reads the stated payment and never checks it; price, payload limits and claims belong to the connector.
