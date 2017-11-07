'use strict'

const request = require('superagent')
const Koa = require('koa')
// TODO check what the overhead of koa-router is and whether there's something faster
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const crypto = require('crypto')
const uuid = require('uuid')
const Debug = require('debug')

async function send (connector, transfer) {
  const debug = Debug('ilp3-send')
  debug('sending transfer', transfer)
  const result = await request.post(connector)
    .set('ILP-Amount', transfer.amount)
    .set('ILP-Expiry', transfer.expiry)
    .set('ILP-Condition', transfer.condition)
    .set('ILP-Destination', transfer.destination)
    .send(transfer.data)

  const fulfillment = result.header['ilp-fulfillment']
  const data = (result.type === 'text/plain' ? result.text : result.body)
  debug(`got fulfillment: ${fulfillment} and data:`, data)
  return {
    fulfillment,
    data
  }
}

async function receiverMiddleware (ctx, next) {
  const debug = Debug('ilp3-receiver')
  const transfer = getTransferFromRequest(ctx.request)
  debug('got transfer:', transfer)
  // TODO validate transfer details
  ctx.state.transfer = transfer

  await next()

  if (ctx.state.fulfillment) {
    ctx.status = 200
    ctx.set('ILP-Fulfillment', ctx.state.fulfillment)
    ctx.body = ctx.body || ctx.state.data
  }
}

function createReceiver (opts) {
  if (!opts) {
    opts = {}
  }
  const path = opts.path || '/'
  const receiver = new Koa()
  const router = new Router()
  receiver.use(bodyParser())
  router.post(path, receiverMiddleware)
  receiver.use(router.routes())
  receiver.use(router.allowedMethods())
  return receiver
}

function createConnector (opts) {
  const routingTable = opts.routingTable
  const path = opts.path || '/'

  const connector = createReceiver()
  const router = new Router()
  router.post(path, async (ctx, next) => {
    const transfer = ctx.state.transfer
    let longestPrefix = null
    for (let prefix in routingTable) {
      if (transfer.destination.startsWith(prefix) && (!longestPrefix || prefix.length > longestPrefix.length)) {
        longestPrefix = prefix
      }
    }
    if (!longestPrefix) {
      return ctx.throw(404, 'no route found')
    }
    const nextConnector = routingTable[longestPrefix]
    // TODO apply exchange rate
    const result = await send(nextConnector, transfer)
    ctx.state.fulfillment = result.fulfillment
    ctx.state.data = result.data
  })
  connector.use(router.routes())
  return connector
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

function hash (fulfillment) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(fulfillment, 'base64'))
  return h.digest()
}

exports.send = send
exports.createReceiver = createReceiver
exports.createConnector = createConnector
