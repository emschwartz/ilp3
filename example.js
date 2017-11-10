'use strict'

const ILP3 = require('.')
const crypto = require('crypto')
const Macaroon = require('macaroon')

const receiverSecret = crypto.randomBytes(32)
const receiver = new ILP3()
  .use(ILP3.macaroons.authenticator({ secret: receiverSecret }))
  .use(ILP3.http.parser())
  .use(ILP3.psk.receiver({ secret: receiverSecret }))
  .use(async (ctx) => {
    console.log(`receiver got payment for ${ctx.transfer.amount} with message:`, ctx.transfer.data.toString('utf8'))
    if (ctx.fulfillment) {
      ctx.data = 'thanks for the money!'
    }
  })
receiver.listen(4000)

const connectorMacaroon = Macaroon.newMacaroon({
  identifier: 'test.receiver',
  rootKey: receiverSecret
})
const encodedConnectorMacaroon = base64url(connectorMacaroon.exportBinary())
const connectorSecret = crypto.randomBytes(32)
const connector = new ILP3()
  .use(ILP3.macaroons.authenticator({ secret: connectorSecret }))
  .use(ILP3.http.parser({ streamData: true }))
  .use(ILP3.balance.inMemoryTracker())
  .use(ILP3.connector.simple({
    routes: {
      'test.sender': {
        currency: 'EUR',
        scale: 6
      },
      'test.receiver': {
        connector: `http://${encodedConnectorMacaroon}@localhost:4000`,
        currency: 'USD',
        scale: 4
      }
    },
    secret: connectorSecret
  }))
  .use(ILP3.macaroons.timeLimiter())
  .use(ILP3.http.client({ streamData: true }))
connector.listen(3000)

const senderMacaroon = Macaroon.newMacaroon({
  identifier: 'test.sender',
  rootKey: connectorSecret
})
senderMacaroon.addFirstPartyCaveat('minBalance -1000')
const encodedSenderMacaroon = base64url(senderMacaroon.exportBinary())
const sender = new ILP3()
  .use(ILP3.psk.sender())
  .use(ILP3.macaroons.timeLimiter())
  .use(ILP3.http.client())

async function main () {
  const start = Date.now()
  const { fulfillment, data } = await sender.send({
    connector: `http://${encodedSenderMacaroon}@localhost:3000`,
    sharedSecret: receiverSecret,
    transfer: {
      destination: 'test.receiver',
      amount: '1000',
      expiry: new Date(Date.now() + 10000).toISOString(),
      data: 'hello there!'
    }
  })
  console.log(`sender got fulfillment: ${fulfillment.toString('base64')}, data: ${data && data.toString('utf8')} in ${Date.now() - start}ms`)
}

main().catch((err) => console.log(err))

function base64url (buffer) {
  return Buffer.from(buffer, 'base64')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

