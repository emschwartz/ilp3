'use strict'

const ILP3 = require('.')
const crypto = require('crypto')
const Macaroon = require('macaroon')
const base64url = require('base64url')

const receiverSecret = crypto.randomBytes(32)
const receiver = ILP3.PSK.createReceiver({ secret: receiverSecret })
receiver.use(async (ctx) => {
  const transfer = ctx.state.transfer
  console.log(`receiver got payment for ${transfer.amount} with message:`, transfer.data.toString('utf8'))
  if (ctx.state.fulfillment) {
    ctx.state.data = 'thanks for the money!'
  }
})
receiver.listen(4000)

const connectorMacaroon = base64url(Macaroon.newMacaroon({
  identifier: 'test.receiver',
  rootKey: receiverSecret
}).exportBinary())
const connectorSecret = crypto.randomBytes(32)
const connector = ILP3.createConnector({
  routes: {
    'test.sender': {
      currency: 'EUR',
      scale: 6
    },
    'test.receiver': {
      connector: 'http://localhost:4000/' + connectorMacaroon,
      currency: 'USD',
      scale: 4
    }
  },
  secret: connectorSecret
})
connector.listen(3000)

const senderMacaroon = base64url(Macaroon.newMacaroon({
  identifier: 'test.sender',
  rootKey: connectorSecret
}).exportBinary())

async function main () {
  await ILP3.PSK.send({
    connector: 'http://localhost:3000/' + senderMacaroon,
    sharedSecret: receiverSecret,
    transfer: {
      destination: 'test.receiver',
      amount: '1000',
      expiry: new Date(Date.now() + 10000).toISOString(),
      data: 'hello there!'
    }
  })
  const start = Date.now()
  const { fulfillment, data } = await ILP3.PSK.send({
    connector: 'http://localhost:3000/' + senderMacaroon,
    sharedSecret: receiverSecret,
    transfer: {
      destination: 'test.receiver',
      amount: '1000',
      expiry: new Date(Date.now() + 10000).toISOString(),
      data: 'hello there!'
    }
  })
  console.log(`sender got fulfillment: ${fulfillment}, data: ${data && data.toString('utf8')} in ${Date.now() - start}ms`)
}

main().catch((err) => console.log(err))
