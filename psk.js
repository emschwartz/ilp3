'use strict'

const assert = require('assert')
const crypto = require('crypto')
const ILP3 = require('./ilp3')
const Router = require('koa-router')
const Debug = require('debug')

const PSK_FULFILLMENT_STRING = 'ilp3_psk_fulfillment'
const NONCE_LENGTH = 18

// transfer should have all fields except condition
function send ({ connector, sharedSecret, transfer }) {
  const debug = Debug('ilp3-psk:send')
  debug('sending transfer to connector:', connector, transfer)
  const nonce = getNonce()

  // TODO encrypt data
  let userData
  if (Buffer.isBuffer(transfer.data)) {
    userData = transfer.data
  } else if (typeof transfer.data === 'object') {
    userData = Buffer.from(JSON.stringify(transfer.data), 'utf8')
  } else if (typeof transfer.data === 'string') {
    userData = Buffer.from(transfer.data, 'utf8')
  } else {
    userData = Buffer.alloc(0)
  }
  const data = Buffer.concat([
    nonce,
    userData
  ])

  const key = hmac(sharedSecret, PSK_FULFILLMENT_STRING)
  const fulfillment = hmac(key, data)
  const condition = hash(fulfillment).toString('base64')
  debug('generated condition:', condition)
  const pskTransfer = Object.assign({}, transfer, {
    data,
    condition
  })
  return ILP3.send({
    connector,
    transfer: pskTransfer
  })
}

function receiverMiddleware ({ secret }) {
  const debug = Debug('ilp3-psk:receiver')
  const key = hmac(secret, PSK_FULFILLMENT_STRING)

  async function receiverMiddleware (ctx, next) {
    if (!ctx.state.transfer.data) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    const data = ctx.state.transfer.data || ''
    const fulfillment = hmac(key, data)
    const condition = hash(fulfillment).toString('base64')
    debug(`regenerated fulfillment: ${fulfillment.toString('base64')} and condition ${condition}, original condition: ${ctx.state.transfer.condition}`)
    if (condition !== ctx.state.transfer.condition) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    ctx.state.fulfillment = fulfillment.toString('base64')
    await next()
    // TODO encrypt response data
  }
  return receiverMiddleware
}

function createReceiver (opts) {
  if (!opts) {
    opts = {}
  }
  assert(opts.secret, 'secret is required')
  assert(Buffer.from(opts.secret, 'base64').length === 32, 'secret must be 32 bytes')
  const path = opts.path || '/'
  const receiver = ILP3.createReceiver(opts)
  const router = new Router()
  router.post(path, receiverMiddleware({
    secret: opts.secret
  }))
  receiver.use(router.routes())
  return receiver
}

function getNonce () {
  return crypto.randomBytes(NONCE_LENGTH)
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
  h.update(Buffer.from(message, 'utf8'))
  return h.digest()
}

function hash (preimage) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(preimage, 'base64'))
  return h.digest()
}

exports.send = send
exports.receiverMiddleware = receiverMiddleware
exports.createReceiver = createReceiver
