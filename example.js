'use strict'

const Koa = require('koa')
const ILP3 = require('.')
const levelup = require('levelup')
const leveldown = require('leveldown')
const crypto = require('crypto')
const base64url = require('./lib/util/base64url')
const sublevel = require('./lib/util/sublevel')

const receiverSecret = crypto.randomBytes(32)
const receiver = new ILP3()
  .use(ILP3.http.parser())
  .use(ILP3.PSK.receiver({ secret: receiverSecret }))
  .use(async (ctx) => {
    console.log(`receiver got payment for ${ctx.transfer.amount}`)
    if (ctx.fulfillment) {
      ctx.data = 'thanks for the money!'
    }
  })
const receiverServer = new Koa()
receiverServer.use(receiver.middleware())
receiverServer.listen(4000)

const connectorDb = levelup(leveldown('./connector-db'))
const balanceTracker = ILP3.balance.tracker({
  leveldown: sublevel(connectorDb, 'balance')
})
const connectorRouter = new ILP3.connector.Simple({
  spread: 0.01
})
connectorRouter.addRoute('test.receiver', {
  uri: `http://localhost:4000`,
  currencyCode: 'USD',
  currencyScale: 4
})
const connector = new ILP3()
  .use(ILP3.http.parser({ streamData: true }))
  .use(ILP3.xrp.incoming({
    address: 'rw3PbBm3HJGXtJUxstWWDtu1i3U7ss9T2T',
    secret: 'spzTqcr8LTrFfBPLdevZkcaqJb8Xu',
    server: 'wss://s.altnet.rippletest.net:51233'
  }))
  .use(ILP3.bandwidth.adjuster({
    leveldown: sublevel(connectorDb, 'bandwidth'),
    increaseRatio: 0.005,
    maximum: 10000
  }))
  .use(balanceTracker.incoming())
  .use(connectorRouter.middleware())
  .use(balanceTracker.outgoing())
  .use(ILP3.fulfillments.validator())
  .use(ILP3.http.client({ streamData: true }))
const connectorServer = new Koa()
connectorServer.use(connector.middleware())
connectorServer.listen(3000)

const sender = new ILP3.SimpleSender({
  xrpAddress: 'rMRyYByxGS48tfu5Qvy9n9G7mqQT6HvKcg',
  xrpSecret: 'ssXVACGdHGcUdWjMM5E5fj5dCJFdu',
  livenet: false
})

async function main () {
  const start = Date.now()
   //Get a quote first
  const quote = await sender.quote({
    sharedSecret: receiverSecret,
    destination: 'test.receiver',
    sourceAmount: 1000,
  })
  console.log(`got end-to-end quote. source amount 1000 is equal to ${quote.destinationAmount} on test.receiver`)

  const result = await sender.send({
    sharedSecret: receiverSecret,
    destination: 'test.receiver',
    sourceAmount: '1000',
  })
  console.log(`sender sent 1000, receiver received ${result.destinationAmount}`)

  const result2 = await sender.deliver({
    sharedSecret: receiverSecret,
    destination: 'test.receiver',
    destinationAmount: '500',
  })
  console.log(`sender delivered ${result2.destinationAmount} by sending ${result2.sourceAmount}`)
}

main().catch((err) => console.log(err))

