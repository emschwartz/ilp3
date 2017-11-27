# ILPv3 - A new take on Interledger

**This is a prototype. Nothing is finished, everything could change and feedback is welcome.**

## Overview

ILPv3 is a different take on Interledger that aims to simplify the protocol stack and implementation even further and get the open Interledger started faster. It begins with the premise that all payments will be small and larger ones will be sent as [Chunked Payments](#streaming-and-chunked-payments). Building for small payments makes connectors simpler, lowers their risk, and should make the system more competitive.

ILPv3 also adopts a number of other simplifications, including making quoting an end-to-end concern and making a standard ILP packet encoding optional (i.e. no OER if you don't want it). The ledger layer protocol used here is just a couple of ILP headers (`ILP-Destination`, `ILP-Condition`, `ILP-Expiry`) attached to a standard HTTP request (the ILP packet data is the HTTP body).

This implementation uses a "middleware function"-based architecture, inspired by [Koa.js](http://koajs.com/), instead of the [Ledger Plugin](https://interledger.org/rfcs/0004-ledger-plugin-interface/) design. Requests are passed through a stack of functions that handle behavior such as parsing ILP details, checking a user's balance, and sending outgoing transfers using specific ledger protocols. Middleware functions can be composed into senders, connectors, and receivers (see [example.js](./example.js)), enabling greater code reuse and easier extensibility.

## Trying It Out

Clone the repo, `npm install`, and run `DEBUG=* node example.js` to see end-to-end quoting and chunked payments in action over XRP Payment Channels.

## Building for Small Payments

> "Streaming payments change everything." - @justmoon

Building an Interledger implementation designed exclusively for small payments enables us to make a number of important simplifications to the protocols and stack. This not only makes Interledger fit better with our target use case of micropayments, but there are reasons to believe that all payments may become micropayments (if you're saying "whaat??", read on).

**Streaming Payments** are payments sent in many little increments in exchange for an ongoing or streaming service, such as paying for a movie 1 Mb at a time. We used to use this to also refer to what we now call Chunked Payments.

**Chunked Payments** are larger payments split into smaller chunks for sending over the Interledger. Now why would you want to do that?

### Advantages of Chunked Payments

#### 1. Accommodating Low Maximum Payment Sizes

Every payment path through the Interledger will have some Maximum Payment Size (MPS, like the Internet's Maximum Transmission Unit or how large packets can be). The average MPS is likely to be low because of connector risk and liquidity factors. Chunked payments will be required if senders ever want to send larger amounts than the path MPS.

#### 2. Enabling Smaller Connectors

There are simply more parties in the world that could facilitate a $0.10 payment than a $10,000 payment. Splitting larger payments into many small ones allows connectors with less liquidity to participate in the Interledger.

#### 3. Increasing Competition

This is the main reason we expect Interledger payments to be significantly cheaper than traditional payments in the medium to long term. The more connectors can compete to facilitate each payment, the cheaper they should be.

#### 4. Reducing Connector Risk

One of the main risks for Interledger connectors is failing to fulfill an incoming payment in time, and thus losing the principal of a payment. The smaller each payment, the lower the risk. If connectors are sending many tiny payments and some of them start failing, mitigation strategies can be used to avoid losing more money. Smaller payments also enable shorter timeouts (because the downside of payments failing is lower) and reduce the free option problem that comes with conditional payments.

#### 5. Works with Simple Payment Channels

Interledger can be used with any ledger using different types of [Hashed Timelock Agreements](https://interledger.org/rfcs/0022-hashed-timelock-agreements/). [Simple (unconditional) payment channels](https://interledger.org/rfcs/0022-hashed-timelock-agreements/#simple-payment-channels) are arguably a good balance between ledger requirement complexity (XRP, Ethereum, and Bitcoin, even without SegWit, support these), speed, and cost. If all payments are small, the risk to connectors posed by peers running off before sending a payment channel update can be reduced to an acceptable amount (note that senders still do not need to trust connectors).

#### 6. Protocol Simplicity

If we can assume all payments are small, we can simplify the Interledger protocol stack further. For example, [liquidity curves](https://github.com/interledger/rfcs/blob/master/0008-interledger-quoting-protocol/0008-interledger-quoting-protocol.md#quoteliquidityresponse) are only necessary if payments vary greatly in size. A simple exchange rate suffices for small payments.

#### 7. Hiding Test Payments

If all payments across the Interledger are small, it should be harder for connectors to identify test payments sent by other connectors to probe routes. This should enable connectors to keep better statistics on the real rates and connectivity provided by their peers.

### Disadvantages of Chunked Payments

**Note:** These are potentially serious issues, but it is important to note that they are inevitable if anyone ever wants to send larger payments than the payment path can support. One of the main questions we have to answer now is whether we expect the average Maximum Payment Size to be on the order of $1, $10, $100, $1000 or more. The higher this number, the greater the risk and liquidity requirements will be for connectors, which in turn limits the pool of potential connectors.

#### 1. Partial Payments

If the whole payment is no longer delivered atomically, there is a possibility that the path could run out of liquidity mid-payment and the receiver would end up with only some of the money they requested. In most cases, the sender should be able to keep retrying chunks until the whole payment is delivered. However, if the path completely runs out of liquidity (which should happen extremely rarely), receivers might need to send back payments that cannot be completed.

#### 2. Fluctuating Exchange Rates

The rate for a payment can change due to legitimate or illegitimate reasons after the first chunk is sent but before the last one is received. If the exchange rate changes dramatically and unpredictably over the course of a payment, it would make for a bad sender experience.

## Differences from ILPv1

### Interledger Layer

#### 1. Forwarding Only

Connectors only "forward" payments, applying their own rate to the incoming transfer to get the outgoing transfer amount. There is no ["delivery"](https://github.com/interledger/rfcs/issues/77) so connectors do not need to know the exact and up-to-date exchange rates of all other connectors.

#### 2. No Prefix Restrictions on ILP Addresses

In order to support the "delivery" feature, connectors needed to know whether they were the last hop in a payment path and thus whether an ILP address was "local". This required restrictions on ILP addresses (not being able to use a ledger's address in another ledger's prefix unless the exchange rate is 1:1) that are unnecessary in a forwarding-only system.

#### 3. No Destination Amount in the ILP Packet

The amount field in the ILP packet was intended for transport layer protocols and for connectors to be able to deliver the exact destination amount. Since there is no delivery, there is no need for a destination amount field to be part of the standard ILP packet understood by every connector. Transport layer protocols can include the amount in the data field if they so choose.

#### 4. End-to-End Quoting

The requirements for quoting are inextricably linked to the transport protocol being used. For example, a static, non-binding ILQP quote is not very helpful for a streaming or chunked payment because the rate may change over time. ILPv3 makes quoting functionality part of the transport protocol and removes the need for an Interledger Quoting Protocol that must be understood by all connectors. Instead, senders and receivers use test payments (which can be fulfilled or rejected depending on the use case) to determine how much money arrives when a certain source amount is sent. (I believe @justmoon came up with the idea of using test payments for quoting)

#### 5. No Standard Packet Encoding

The main reasons for having a canonical ILP packet format were a) to have a consistent encoding for ILP and other Interledger layer protocols such as ILQP b) to distinguish the Interledger layer details from the ledger layer details and c) for transport layer protocols to be able to hash the packet into the condition as IPR and PSK do. Point a) is no longer applicable because there is only ILP, there are no other protocols on the Interledger layer. After the "Interledger Enlightenment", b) is no longer necessary because we make less of a distinction between ledgers and connectors, and connectors need to see the destination address alongside the incoming transfer amount. Finally, transport layer protocols can hash the data by itself instead of the "packet" as a whole. Given all of these, having a standard encoding becomes only a nice-to-have that can prevent the few unchanging fields in an ILP payment (destination address, data, and condition) from being decoded and reencoded at every hop. However, this is not strictly necessary and does not need to be standardized up-front. (@adrianhopebailie was the one that first [took issue](https://github.com/interledger/rfcs/pull/270) with the distinction between the Interledger and ledger layers)

#### 6. Simple Exchange Rates Instead of Liquidity Curves

Liquidity curves were necessary to express how exchange rates varied with payment size. If all payments are assumed to be small, this complex feature can be replaced by a single number representing the exchange rate.

#### 7. (Potentially) Higher Data Limit

In this implementation, the ILP data is simply the body of an HTTP request, which connectors can stream from the incoming request to the outgoing request, rather than buffering it all into memory. If that becomes standard practice, connectors could allow larger amounts of data to travel with ILP payments, because the impact on the connector would be minimal.

### Ledger Layer

#### 1. Fulfillments and Errors are Responses, Not Requests

In most cases, there is nothing a connector can do if they try to pass back a fulfillment or an error and it is not accepted.

#### 2. Transfers Only

Since there is no ILQP, there is no need for the ledger layer protocol to do messaging or anything other than sending transfers. Other protocols such as those related to routing can be built either on top of TCP/IP or Interledger payments.

#### 3. Recommend Using HTTP

Since the ledger layer protocol only needs to handle a single request/response call with a couple of structured fields and some opaque data, HTTP is a perfect protocol for this. The ILP-related fields can be sent as headers and the ILP data can be sent as the HTTP body. Nearly all programming languages support HTTP and no additional encoding library would be needed to implement ILP. HTTP Keepalive or HTTP2 can be used to avoid the extra round trips for TCP and TLS when multiple payments are being sent between the same two peers. Implementations may still abstract away the communication protocol used to enable using alternatives such as RPC over Websockets.

#### 4. Fast HTLAs Only

Interledger can theoretically support a wide variety of ledger integrations (see [Hashed Timelock Agreements (HTLAs)](https://interledger.org/rfcs/0022-hashed-timelock-agreements/#simple-payment-channels)), but today, most ledgers available are too slow or expensive for on-ledger escrow to provide a good experience. Payment channels and trustlines should be the only recommended HTLA types for now and other protocols should be built to assume that transfers can be executed in milliseconds, as opposed to seconds or longer. This recommendation would change once ledgers are capable of processing large volumes of payments with negligible costs and latency.

### Transport Layer

#### 1. Only Hash Data

Unlike PSK 1.0, this implementation of PSK only hashes the ILP data, rather than the whole ILP packet.

#### 2. Include End-to-End Quoting and Chunked Payments

In addition to encrypting the end-to-end data and generating the fulfillment and condition, this version of PSK also handles end-to-end quoting and chunked payments. This allows all details associated with these use cases to be encrypted within the PSK data, and allows senders to assume that any receiver that supports PSK will support end-to-end quoting and chunked payments. @sentientwaffle raised the question of whether E2E quoting and chunked payments should be part of PSK or implemented as a separate "layer" built on top of it (so PSK would only handle encryption and condition generation), and this should be discussed further.

#### 3. Out of Band Cipher Negotiation

PSK 1.0 includes the cipher suite in the "public headers" outside of the encrypted data. Instead of putting plaintext data into the ILP data, the cipher negotiation should be part of the PSK details exchanged between the sender and receiver (which currently consist of the receiver's address and the shared secret). This version of PSK assumes the cipher is AES-256-GCM.

#### 4. No Set Destination Amount

Currently, this implementation of PSK does not include a destination amount in the encrypted data. The receiver fulfills every incoming chunk they see and they use the fulfillment data to communicate back to the sender how much arrived (this is encrypted and authenticated). It is then up to the sender whether they want to continue sending more chunks, the chunk size to use, and whether they should switch to a different connector. @michielbdejong has raised a number of potential issues with this approach, which should be explored in greater depth.

One alternative would be for the sender to use the first payment chunk as a kind of quote and then to inform the receiver how much to expect on each successive chunk. This would provide the same properties as requesting a quote using ILQP and then sending multiple payments using ILPv1. However, connectors could still play with their rates on the first chunk.

### Implementation

#### 1. Middleware Instead of Plugins

The idea of [Ledger Plugins](https://interledger.org/rfcs/0004-ledger-plugin-interface/) was to enable the same ILP client and connector software to be used with different ledgers. However, we found that we needed additional ways to reuse code across plugins (see the [Payment Channel Plugin Framework](https://github.com/interledgerjs/ilp-plugin-payment-channel-framework/)), which suggests that plugins are not the best way to structure the code internally. Inspired by [Koa.js](http://koajs.com/) and [levelup](https://github.com/Level/levelup), this implementation separates tasks into a stack of middleware functions that handle various checks or transformations and then pass control to the next function. This design makes it easier to add new functionality into the flow, such as a balance checker that uses a specific database, a transfer logger, or a new ledger layer protocol. See the [Middleware API](#middleware-api) below for more details.

#### 2. Single Process Per Account

Individual account balances must be kept consistent, so those are likely to always be a performance bottleneck. As pioneered by @justmoon in the [`ilp-connector-shard`](https://github.com/interledgerjs/ilp-connector-shard), this implementation assumes that each account will be managed by a single process. This allows the balance to be cached and updated in memory and enables using fast, single-process databases such as [LevelDB](http://leveldb.org/) or [RocksDB](http://rocksdb.org/).

#### 3. Don't Persist Prepared Transfers

If an account is managed by a single process and transfer timeouts are short, the balance change from a prepared transfer can be kept in memory instead of on disk. If the connector server crashes before the transfer was finalized, it is unlikely that the server will come back online in time for the transfer to be fulfilled, so there is little point in persisting the prepared transfer. This makes the speed of preparing a payment end-to-end equal to the network latency plus a small number of in-memory operations, which should be extremely fast. Even when transfers are fulfilled, the balance changes can be persisted after the fulfillment is passed on.

#### 4. Stream ILP Data

ILP data is end-to-end, so connectors can stream the data from the incoming request to the outgoing request without buffering it into memory. This should enable connectors to have higher data limits with less impact on their server performance.

## Middleware API

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
- [x] Use a single db for all of the connector middleware
- [x] Receiver can request that the connector create a payment channel to them
- [x] Connector stores routes in db
- [ ] Connector uses IP-based rate limiting and tracks accounts that don't submit claims
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
