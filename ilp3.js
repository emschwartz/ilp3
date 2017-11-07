'use strict'

const fetch = require('node-fetch')
const Koa = require('koa')
// TODO check what the overhead of koa-router is and whether there's something faster
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const Debug = require('debug')

async function send ({ connector, transfer }) {
  const debug = Debug('ilp3:send')
  debug('sending transfer', transfer)
  const headers = Object.assign({
    'ILP-Amount': transfer.amount,
    'ILP-Expiry': transfer.expiry,
    'ILP-Condition': transfer.condition,
    'ILP-Destination': transfer.destination,
    'User-Agent': ''
  }, transfer.additionalHeaders || {})
  let body
  if (!transfer.data) {
    body = null
  } else if (typeof transfer.data === 'object' && !Buffer.isBuffer(transfer.data)) {
    body = JSON.stringify(transfer.data)
    headers['Content-Type'] = 'application/json'
  } else {
    // TODO send data as binary
    body = transfer.data.toString('base64')
    headers['Content-Type'] = 'text/plain'
  }
  const result = await fetch(connector, {
    method: 'POST',
    headers,
    body,
    compress: false
  })

  const fulfillment = result.headers.get('ilp-fulfillment')
  const contentType = result.headers.get('content-type')
  let data
  if (contentType.startsWith('application/json')) {
    data = await result.json()
  } else if (contentType.startsWith('application/octet-stream')) {
    data = await result.buffer()
  } else if (contentType.startsWith('text/plain')) {
    data = await result.text()
  } else {
    debug('got response with unrecognized content-type:', contentType)
    data = null
  }

  debug(`got fulfillment: ${fulfillment} and data:`, data)
  return {
    fulfillment,
    data
  }
}

function receiverMiddleware () {
  return async (ctx, next) => {
    const debug = Debug('ilp3:receiver')
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
}

function createReceiver (opts) {
  if (!opts) {
    opts = {}
  }
  const path = opts.path || '/'
  const receiver = new Koa()
  const router = new Router()
  receiver.use(bodyParser({
    enableTypes: ['text', 'json'],
    strict: true
  }))
  router.post(path, receiverMiddleware())
  receiver.use(router.routes())
  receiver.use(router.allowedMethods())
  return receiver
}

function createConnector (opts) {
  const debug = Debug('ilp3-connector')
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
    try {
      const result = await send({
        connector: nextConnector,
        transfer
      })
      ctx.state.fulfillment = result.fulfillment
      ctx.state.data = result.data
    } catch (err) {
      debug('error forwarding payment to: ' + nextConnector, err)
      return ctx.throw(err)
    }
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

exports.send = send
exports.createReceiver = createReceiver
exports.createConnector = createConnector
