'use strict'

const ILP3 = require('.')
const crypto = require('crypto')
const Macaroon = require('macaroon')
const Koa = require('koa')

function base64url (buffer) {
  return Buffer.from(buffer, 'base64')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

const receiverSecret = crypto.randomBytes(32)
const receiver = new ILP3.ILP3()
  .use(ILP3.macaroonAuthenticator({ secret: receiverSecret }))
  .use(ILP3.httpParser())
  .use(ILP3.PSK.receiver({ secret: receiverSecret }))
  .use(async (ctx) => {
    const transfer = ctx.transfer
    console.log(`receiver got payment for ${transfer.amount} with message:`, transfer.data.toString('utf8'))
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
const connector = new ILP3.ILP3()
  .use(ILP3.macaroonAuthenticator({ secret: connectorSecret }))
  .use(ILP3.httpParser({ streamData: true }))
  .use(ILP3.inMemoryBalanceTracker())
  .use(ILP3.connector({
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
  .use(ILP3.httpSender())
connector.listen(3000)

const senderMacaroon = Macaroon.newMacaroon({
  identifier: 'test.sender',
  rootKey: connectorSecret
})
senderMacaroon.addFirstPartyCaveat('minBalance -1000')
const encodedSenderMacaroon = base64url(senderMacaroon.exportBinary())
const sender = new ILP3.ILP3()
  .use(ILP3.PSK.sender())
  .use(ILP3.httpSender())

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
