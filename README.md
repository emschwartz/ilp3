# ILPv3

**This is a prototype. Nothing is finished and everything could change.**

An implementation of the Interledger Protocol V3.

See [./example.js](./example.js) for how to use it.

## TODOs

- [x] Connector exchange rates
- [x] Connector streams data from incoming to outgoing request
- [x] Send authorization in HTTP header
- [x] Sender automatically caveats macaroon token
- [ ] Connector keeps balances for multiple senders
- [ ] Error handler that produces machine-readable error objects
- [ ] Quoting
- [ ] Compatibility API (that mimicks the `ilp` module for ILPv1)
- [ ] Payment channel support (minimal plugin architecture?)
