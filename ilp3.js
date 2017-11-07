'use strict'

// should ledger protocols be connection-oriented or more like HTTP (or HTTP2)?
// does it make sense to separately handle events like reject and fulfill if those are basically just the responses to the prepare?
// if you aren't going to act on the notification that a fulfill or reject was not accepted, you don't need to know it anyway
// (that's kind of like the fact that an HTTP server doesn't find out that the client didn't like their response)
// should there be one module that does sending and receiving, or should that be split like in HTTP?
// note that one of the things the current ilp2 implementation has to do a lot is store incoming/outgoing transfers to be able to
// look up the transfer details when it gets the response -- it seems like you fundamentally need to store the context,
// which suggests that it might make sense to think of it like Michiel's proxying ledger concept (except it's now proxying connector)


const request = require('superagent')
const Koa = require('koa')
const route = require('koa-route')
const bodyParser = require('koa-bodyparser')
const crypto = require('crypto')
const uuid = require('uuid')

function hash (fulfillment) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(fulfillment, 'base64'))
  return h.digest()
}

const fulfillment = crypto.randomBytes(32).toString('base64')
const condition = hash(fulfillment).toString('base64')

async function send (connector, transfer) {
  const result = await request.post(connector)
    .set('ilp-amount', transfer.amount)
    .set('ilp-expiry', transfer.expiry)
    .set('ilp-condition', transfer.condition)
    .set('ilp-destination', transfer.destination)
    .send(transfer.data)

  return {
    fulfillment: result.header['ilp-fulfillment'],
    data: result.body
  }
}

function getTransferFromRequest (request) {
  return {
    amount: request.headers['ilp-amount'],
    expiry: request.headers['ilp-expiry'],
    condition: request.headers['ilp-condition'],
    destination: request.headers['ilp-destination'],
    data: request.body
  }
}

const connector = new Koa()
connector.use(bodyParser())
connector.use(route.post('/', async (ctx) => {
  const transfer = getTransferFromRequest(ctx.request)

  console.log('connector got request', transfer)
  // this would be looked up in a routing table
  const nextConnector = 'http://localhost:4000'
  const outgoingTransfer = Object.assign({}, transfer, {
    id: uuid(),
    expiry: new Date(Date.parse(transfer.expiry) - 1000).toISOString()
  })
  try {
    const result = await send(nextConnector, outgoingTransfer)
    ctx.body = result.data
    ctx.set('ilp-fulfillment', result.fulfillment)
    ctx.status = 200
  } catch (err) {
    console.log('connector got error sending outgoing transfer', err)
  }
}))
connector.listen(3000)

const receiver = new Koa()
receiver.use(bodyParser())
receiver.use(route.post('/', async (ctx) => {
  const transfer = getTransferFromRequest(ctx.request)
  if (transfer.condition === condition) {
    console.log('condition matches')
    ctx.status = 200
    ctx.set('ilp-fulfillment', fulfillment)
    ctx.body = 'thanks for the money!'
  }
}))
receiver.listen(4000)

async function main () {
  const result = await send('http://localhost:3000', {
    destination: 'test.receiver',
    to: 'test.connector',
    from: 'test.sender',
    amount: '10',
    condition: condition,
    expiry: new Date(Date.now() + 10000).toISOString()
  })
  console.log('sender got fulfillment', result)
}

main().catch((err) => console.log(err))

