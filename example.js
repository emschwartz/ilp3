'use strict'

const ILP3 = require('./ilp3')
const crypto = require('crypto')

const fulfillment = crypto.randomBytes(32).toString('base64')
const h = crypto.createHash('sha256')
h.update(Buffer.from(fulfillment, 'base64'))
const condition = h.digest().toString('base64')

const receiver = ILP3.createReceiver()
receiver.use(async (ctx) => {
  console.log('receiver got transfer', ctx.state.transfer)
  ctx.state.fulfillment = fulfillment
  ctx.state.data = 'hello'
})
receiver.listen(4000)

const connector = ILP3.createConnector({
  routingTable: {
    'test.': 'http://localhost:4000'
  }
})
connector.listen(3000)

async function main () {
  const result = await ILP3.send('http://localhost:3000', {
    destination: 'test.receiver',
    amount: '10',
    condition: condition,
    expiry: new Date(Date.now() + 10000).toISOString()
  })
  console.log('sender got fulfillment', result)
}

main().catch((err) => console.log(err))
