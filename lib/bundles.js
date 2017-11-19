'use strict'

const PskSender = require('./psk').Sender
const xrpOutgoing = require('./middleware/xrp').outgoing
const fulfillmentValidator = require('./middleware/fulfillments').validator
const httpClient = require('./middleware/http').client
const connectorList = require('./middleware/connector-list')

const XRP_TESTNET_SERVER = 'wss://s.altnet.rippletest.net:51233'
const XRP_LIVENET_SERVER = 'wss://s1.ripple.com'

class SimpleSender extends PskSender {
  constructor (opts) {
    super(opts)

    if (opts.xrpSecret && opts.xrpAddress) {
      const livenet = !!opts.livenet
      if (!livenet) {
        this.use(connectorList.xrpTestnet())
      }
      const server = opts.xrpServer || (livenet ? XRP_LIVENET_SERVER : XRP_TESTNET_SERVER)
      this.use(xrpOutgoing({
        address: opts.xrpAddress,
        secret: opts.xrpSecret,
        server
      }))
    }

    // TODO add other cryptocurrencies

    this.use(fulfillmentValidator())
    this.use(httpClient())
  }
}

exports.SimpleSender = SimpleSender
