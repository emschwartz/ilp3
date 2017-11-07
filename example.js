'use strict'

const ILP3 = require('.')
const crypto = require('crypto')

const secret = crypto.randomBytes(32)
const receiver = ILP3.PSK.createReceiver({ secret })
receiver.use(async (ctx) => {
  if (ctx.state.fulfillment) {
    ctx.state.data = 'thanks for the money!'
  }
})
receiver.listen(4000)

const connector = ILP3.createConnector({
  routingTable: {
    'test.': 'http://localhost:4000'
  }
})
connector.listen(3000)

async function main () {
  const { fulfillment, data } = await ILP3.PSK.send({
    connector: 'http://localhost:3000',
    sharedSecret: secret,
    transfer: {
      destination: 'test.receiver',
      amount: '10',
      expiry: new Date(Date.now() + 10000).toISOString()
    }
  })
  console.log(`sender got fulfillment: ${fulfillment}, data: ${data.toString('utf8')}`)
}

main().catch((err) => console.log(err))
