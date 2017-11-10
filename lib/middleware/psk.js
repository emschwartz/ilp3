'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Debug = require('debug')

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const PSK_FULFILLMENT_STRING = 'ilp3_psk_fulfillment'
const PSK_ENCRYPTION_STRING = 'ilp3_psk_encryption'
const NONCE_LENGTH = 18
const AUTH_TAG_LENGTH = 16

// transfer should have all fields except condition
function sender () {
  return async function (ctx, next) {
    const debug = Debug('ilp3-psk:sender')
    const sharedSecret = ctx.sharedSecret
    const transfer = ctx.transfer
    assert(sharedSecret, 'sharedSecret is required')
    assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')

    // Encrypt data
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

    // Generate condition using shared secret and data
    // Note that the encrypt call automatically adds a nonce to the data,
    // which makes the condition unique
    const key = hmac(sharedSecret, PSK_FULFILLMENT_STRING)
    const fulfillment = hmac(key, data)
    const condition = hash(fulfillment).toString('base64')
    debug('generated condition:', condition)

    // Update the context and pass control over to the next handler
    ctx.transfer = Object.assign({}, transfer, {
      data,
      condition
    })
    delete ctx.sharedSecret

    try {
      await next()
    } catch (err) {
      debug('error sending transfer', err)
      throw err
    }

    // Decrypt the repsponse data if there was any
    let decryptedData = null
    try {
      if (ctx.data) {
        decryptedData = decrypt(sharedSecret, ctx.data)
      }
    } catch (err) {
      debug('error decrypting response data', err)
    }
    ctx.data = decryptedData
    ctx.fulfillment = fulfillment
  }
}

function receiver ({ secret }) {
  const debug = Debug('ilp3-psk:receiver')
  const key = hmac(secret, PSK_FULFILLMENT_STRING)
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')

  return async function (ctx, next) {
    const transfer = ctx.transfer
    if (!transfer.data) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    debug('attempting to regenerate fulfillment from data')
    const data = transfer.data || ''
    const fulfillment = hmac(key, data)
    const condition = hash(fulfillment).toString('base64')
    debug(`regenerated fulfillment: ${fulfillment.toString('base64')} and condition ${condition}, original condition: ${transfer.condition}`)
    if (condition !== transfer.condition) {
      return ctx.throw(400, 'unable to regenerate fulfillment')
    }
    let decryptedData
    try {
      decryptedData = decrypt(secret, data)
    } catch (err) {
      debug('error decrypting data:', err)
      return ctx.throw(400, 'unable to decrypt data')
    }

    ctx.fulfillment = fulfillment.toString('base64')
    ctx.transfer.data = decryptedData

    await next()

    // Encrypt response data
    if (ctx.data) {
      ctx.data = encrypt(secret, ctx.data)
    }
  }
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

exports.sender = sender
exports.receiver = receiver
