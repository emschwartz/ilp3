'use strict'

const assert = require('assert')
const crypto = require('crypto')
const ILP3 = require('./ilp3')
const Router = require('koa-router')
const Debug = require('debug')

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const PSK_FULFILLMENT_STRING = 'ilp3_psk_fulfillment'
const PSK_ENCRYPTION_STRING = 'ilp3_psk_encryption'
const NONCE_LENGTH = 18
const AUTH_TAG_LENGTH = 16

// transfer should have all fields except condition
async function send ({ connector, sharedSecret, transfer }) {
  const debug = Debug('ilp3-psk:send')
  assert(sharedSecret, 'sharedSecret is required')
  assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')

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
  const data = encrypt(sharedSecret, userData)

  const key = hmac(sharedSecret, PSK_FULFILLMENT_STRING)
  const fulfillment = hmac(key, data)
  const condition = hash(fulfillment).toString('base64')
  debug('generated condition:', condition)
  const pskTransfer = Object.assign({}, transfer, {
    data,
    condition
  })
  let result
  try {
    result = await ILP3.send({
      connector,
      transfer: pskTransfer
    })
  } catch (err) {
    debug('error sending transfer', err)
    throw err
  }
  let responseData = null
  try {
    if (result.data) {
      responseData = decrypt(sharedSecret, result.data)
    }
  } catch (err) {
    debug('error decrypting response data', err)
  }
  return {
    fulfillment: result.fulfillment,
    data: responseData
  }
}

function receiverMiddleware ({ secret }) {
  const debug = Debug('ilp3-psk:receiver')
  const key = hmac(secret, PSK_FULFILLMENT_STRING)
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')

  async function receiverMiddleware (ctx, next) {
    if (!ctx.state.transfer.data) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    debug('attempting to regenerate fulfillment from data')
    const data = ctx.state.transfer.data || ''
    const fulfillment = hmac(key, data)
    const condition = hash(fulfillment).toString('base64')
    debug(`regenerated fulfillment: ${fulfillment.toString('base64')} and condition ${condition}, original condition: ${ctx.state.transfer.condition}`)
    if (condition !== ctx.state.transfer.condition) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    let decryptedData
    try {
      decryptedData = decrypt(secret, data)
    } catch (err) {
      debug('error decrypting data:', err)
      return ctx.throw(400, 'unable to decrypt data')
    }

    ctx.state.fulfillment = fulfillment.toString('base64')
    ctx.state.transfer.data = decryptedData

    await next()

    // Encrypt response data
    if (ctx.state.data) {
      ctx.state.data = encrypt(secret, ctx.state.data)
    }
  }
  return receiverMiddleware
}

function createReceiver (opts) {
  if (!opts) {
    opts = {}
  }
  assert(opts.secret, 'secret is required')
  assert(Buffer.from(opts.secret, 'base64').length === 32, 'secret must be 32 bytes')
  const path = opts.path || '*'
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

function encrypt (secret, buffer) {
  const nonce = getNonce()
  const pskEncryptionKey = hmac(secret, PSK_ENCRYPTION_STRING)
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, pskEncryptionKey, nonce)

  const encryptedInitial = cipher.update(buffer)
  const encryptedFinal = cipher.final()
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    nonce,
    tag,
    encryptedInitial,
    encryptedFinal
  ])
}

function decrypt (secret, buffer) {
  const pskEncryptionKey = hmac(secret, PSK_ENCRYPTION_STRING)
  const nonce = buffer.slice(0, NONCE_LENGTH)
  const tag = buffer.slice(NONCE_LENGTH, NONCE_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = buffer.slice(NONCE_LENGTH + AUTH_TAG_LENGTH)
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, pskEncryptionKey, nonce)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ])
}

exports.send = send
exports.receiverMiddleware = receiverMiddleware
exports.createReceiver = createReceiver
