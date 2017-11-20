# ILPv3

**This is a prototype. Nothing is finished and everything could change.**

An implementation of the Interledger Protocol V3.

## Getting Started

### As a Sender

```js
const { SimpleSender } = require('ilp3')
const sender = new SimpleSender({
  xrpAddress: 'rMRyYByxGS48tfu5Qvy9n9G7mqQT6HvKcg',
  xrpSecret: 'ssXVACGdHGcUdWjMM5E5fj5dCJFdu',
  livenet: false
})

sender.quote({
  sharedSecret: receiverSecret,
  destination: 'test.receiver',
  sourceAmount: 1000,
}).then((quote) => {
  console.log(quote.destinationAmount)
})

sender.send({
  sharedSecret: receiverSecret,
  destination: 'test.receiver',
  sourceAmount: '1000',
}).then((result) => {
  console.log(result.destinationAmount)
})

sender.deliver({
  sharedSecret: receiverSecret,
  destination: 'test.receiver',
  destinationAmount: '1000',
}).then((result) => {
  console.log(result.sourceAmount)
})
```

### As a Receiver

See [./example.js](./example.js)

### As a Connector

See [./example.js](./example.js)

## ILP3 Middleware API

ILP3 middleware functions use the following properties on the context (`ctx`) object:

* `ctx.incoming.transfer`
* `ctx.incoming.account`
* `ctx.outgoing.transfer`
* `ctx.outgoing.account`

### Transfer Schema

| Property | Type | Required? | Description |
|---|---|---|---|
| `amount` | (Positive) Integer String | Y | Transfer amount, denominated in the ledger's minimum units |
| `destination` | ILP Address | Y | Destination address the payment is for |
| `condition` | Buffer or Base64 String | Y | Hashlock condition used to secure the transfer |
| `expiry` | ISO 8601 Timestamp | Y | Expiration date for the transfer |
| `data` | Buffer or Readable Stream | N | End-to-end data |
| `to` | ILP Address | N | Local account the transfer is for |
| `from` | ILP Address | N | Local account the transfer is from |
| `extensions` | Object | N | Additional key-value pairs attached to the transfer (for example, payment channel claims) |

### Account Schema

| Property | Type | Required? | Description |
|---|---|---|---|
| `uri` | URI | N | URI used to communicate with this account-holder |
| `currencyCode` | String | N | Currency code (such as `"USD"`) the account is denominated in |
| `currencyScale` | Number | N | Integer `(..., -2, -1, 0, 1, 2, ...)`, such that one of the ledger's base units equals `10^-<currencyScale> <currencyCode>` |
| `minBalance` | Integer String | N | The minimum balance the account-holder is allowed to have |
| `adjustBalance` | Integer String | N | Used to instruct a balance-tracking middleware to adjust the account's balance by the given amount (for example, `'1000'` would mean the account balance should be credited 1000 and `'-1000'` would mean the account balance should be debited 1000) |


## TODOs

- [x] Connector exchange rates
- [x] Connector streams data from incoming to outgoing request
- [x] Send authorization in HTTP header
- [x] Sender automatically caveats macaroon token
- [x] Unified middleware API for senders, receivers, and connectors
- [x] Connector keeps balances for multiple senders (and adjusts balance on incoming and outgoing transfers)
- [x] Connector uses ILP addresses to determine where transfers are going to / coming from
- [x] Quoting
- [x] Chunked payments
- [x] XRP payment channel claim support
- [x] Sender submits claims after receiving fulfillment
- [x] Save payment channel claims to disk
- [x] Standalone XRP payment channel claim submitter
- [x] Store balances in DB
- [x] Connector dynamically adjusts users' minimum balance
- [ ] Use a single db for all of the connector middleware
- [ ] Figure out how to become a receiver (i.e. get the connector to create a channel to you)
- [ ] Auto-connect to connectors and save config (env file or db?)
- [ ] Bitcoin payment channel support
- [ ] Ethereum payment channel support (ideally including ERC 20 tokens)
- [ ] Configurable congestion avoidance algorithm for chunked payments
- [ ] Separate chunked payments from PSK
- [ ] User data on chunked payments
- [ ] Error handler that produces machine-readable error objects
- [ ] Compatibility API (that mimicks the `ilp` module for ILPv1)
- [ ] Bundle recommended set of middleware for senders, receivers, connectors
- [ ] Auto-fund payment channel when balance is too low
- [ ] Data collection
- [ ] Use normal Passportjs for auth instead of Macaroons
