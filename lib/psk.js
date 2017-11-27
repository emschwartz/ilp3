'use strict'

const assert = require('assert')
const crypto = require('crypto')
const Debug = require('debug')
const Big = require('big.js')
const ILP3 = require('./ilp3')

const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const PSK_FULFILLMENT_STRING = 'ilp3_psk_fulfillment'
const PSK_ENCRYPTION_STRING = 'ilp3_psk_encryption'
const NONCE_LENGTH = 18
const AUTH_TAG_LENGTH = 16
const NULL_CONDITION_BUFFER = Buffer.alloc(32, 0)
const NULL_CONDITION = NULL_CONDITION_BUFFER.toString('base64')
const DEFAULT_TRANSFER_TIMEOUT = 2000
const STARTING_TRANSFER_AMOUNT = 1000
const TRANSFER_INCREASE = 1.1
const TRANSFER_DECREASE = 0.5

const MAX_UINT_64 = Big('18446744073709551615')

const TYPE_QUOTE = 0
const TYPE_CHUNK = 1
const TYPE_LAST_CHUNK = 2

class PskSender extends ILP3 {
  constructor (opts) {
    if (!opts) {
      opts = {}
    }
    super(opts)
    this.randomConditionForQuotes = !!opts.randomConditionForQuotes
  }

  // TODO connector shouldn't need to be passed in here
  async quote ({ sourceAmount, destinationAmount, sharedSecret, destination, connector }) {
    const debug = Debug('ilp3-psk:quote')
    assert(sharedSecret, 'sharedSecret is required')
    assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
    assert(sourceAmount || destinationAmount, 'either sourceAmount or destinationAmount is required')
    assert(!sourceAmount || !destinationAmount, 'cannot supply both sourceAmount and destinationAmount')
    const condition = (this.randomConditionForQuotes ? crypto.randomBytes(32).toString('base64') : NULL_CONDITION)
    const sourceQuote = !!sourceAmount
    const amount = sourceAmount || STARTING_TRANSFER_AMOUNT

    const headers = Buffer.alloc(1)
    headers.writeUInt8(TYPE_QUOTE)

    const transfer = {
      condition,
      amount,
      destination: destination,
      expiry: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT).toISOString(),
      data: encrypt(sharedSecret, headers)
    }

    try {
      await super.send(transfer, { uri: connector })
    } catch (err) {
      if (err.code !== 'F99') {
        throw err
      }
      try {
        const response = decrypt(sharedSecret, err.data)
        const amountArrived = readUInt64(response, 0)
        if (sourceQuote) {
          return {
            destinationAmount: amountArrived.toString()
          }
        } else {
          const sourceAmount = Big(destinationAmount)
            .div(amountArrived)
            .times(STARTING_TRANSFER_AMOUNT)
            .round(0, 1)
          return {
            sourceAmount: sourceAmount.toString()
          }
        }
      } catch (decryptionErr) {
        debug('error decrypting quote response', err, decryptionErr)
        throw err
      }
    }
  }

  // TODO connector shouldn't need to be passed in here
  async send ({ sourceAmount, sharedSecret, destination, connector }) {
    assert(sharedSecret, 'sharedSecret is required')
    assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
    assert(sourceAmount, 'sourceAmount is required')
    return sendChunkedPayment({ sourceAmount, sharedSecret, destination, connector }, super.send.bind(this))
  }

  // TODO connector shouldn't need to be passed in here
  async deliver ({ destinationAmount, sharedSecret, destination, connector }) {
    assert(sharedSecret, 'sharedSecret is required')
    assert(Buffer.from(sharedSecret, 'base64').length >= 32, 'sharedSecret must be at least 32 bytes')
    assert(destinationAmount, 'destinationAmount is required')
    return sendChunkedPayment({ destinationAmount, sharedSecret, destination, connector }, super.send.bind(this))
  }
}

// TODO add option not to chunk the payment
async function sendChunkedPayment ({ sharedSecret, destination, sourceAmount, destinationAmount, connector }, send) {
  const debug = Debug('ilp3-psk:sendChunkedPayment')
  const secret = Buffer.from(sharedSecret, 'base64')
  const paymentId = crypto.randomBytes(16)
  let amountSent = Big(0)
  let amountDelivered = Big(0)
  let numChunks = 0

  const headers = Buffer.alloc(25, 0)
  headers.writeUInt8(TYPE_CHUNK)
  paymentId.copy(headers, 1, 0)
  if (destinationAmount) {
    writeUInt64(headers, destinationAmount, 17)
  }

  let chunkSize = Big(STARTING_TRANSFER_AMOUNT)
  let timeToWait = 0
  while (true) {
    // Figure out if we've sent enough already
    let amountLeftToSend
    if (sourceAmount) {
      amountLeftToSend = Big(sourceAmount).minus(amountSent)
    } else {
      const amountLeftToDeliver = Big(destinationAmount).minus(amountDelivered)
      if (amountLeftToDeliver.lte(0)) {
        break
      }
      if (amountSent.gt(0)) {
        const rate = amountDelivered.div(amountSent)
        amountLeftToSend = amountLeftToDeliver.div(rate).round(0, 3) // round up
      } else {
        // We don't know how much more we need to send
        amountLeftToSend = MAX_UINT_64
      }
    }

    if (amountLeftToSend.lte(0)) {
      break
    } else if (amountLeftToSend.lte(chunkSize)) {
      debug('sending last chunk')
      chunkSize = amountLeftToSend
      headers.writeUInt8(TYPE_LAST_CHUNK, 0)
    }

    // TODO accept user data also
    const data = encrypt(secret, headers)
    const fulfillment = dataToFulfillment(secret, data)
    const condition = hash(fulfillment)

    debug(`sending chunk of: ${chunkSize}`)
    const transfer = {
      destination: destination,
      amount: chunkSize.toString(),
      expiry: new Date(Date.now() + DEFAULT_TRANSFER_TIMEOUT).toISOString(),
      condition: condition.toString('base64'),
      data
    }

    try {
      const result = await send(transfer, { uri: connector })
      amountSent = amountSent.plus(transfer.amount)
      numChunks++
      chunkSize = chunkSize.times(TRANSFER_INCREASE).round(0)
      debug('transfer was successful, increasing chunk size to:', chunkSize.toString())
      timeToWait = 0
      try {
        const decryptedData = decrypt(secret, result.data)
        const amountReceived = readUInt64(decryptedData, 0)
        if (amountReceived.gt(amountDelivered)) {
          amountDelivered = amountReceived
        }
      } catch (err) {
        // TODO update amount delivered somehow so not getting the response back
        // doesn't affect our view of the exchange rate
        debug('error decrypting response data:', err)
        continue
      }
    } catch (err) {
      // TODO handle specific errors
      debug('got error sending payment chunk:', err)
      chunkSize = chunkSize.times(TRANSFER_DECREASE).round(0)
      if (chunkSize.lt(1)) {
        chunkSize = Big(1)
      }
      timeToWait = Math.max(timeToWait * 2, 100)
      await new Promise((resolve, reject) => setTimeout(resolve, timeToWait))
    }
  }

  return {
    sourceAmount: amountSent.toString(),
    destinationAmount: amountDelivered.toString(),
    numChunks
  }
}

function receiver ({ secret, notifyEveryChunk }) {
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')
  const debug = Debug('ilp3-psk:receiver')

  const payments = {}

  return async function (ctx, next) {
    // TODO check that destination matches our address
    const transfer = ctx.incoming.transfer

    let decryptedData
    try {
      decryptedData = decrypt(secret, transfer.data)
    } catch (err) {
      debug('error decrypting data:', err)
      const ilpError = new Error('unable to decrypt data')
      ilpError.status = 400
      ilpError.code = 'F01'
      ilpError.triggeredAt = new Date().toISOString()
      throw ilpError
    }

    const type = decryptedData.readUInt8(0)
    if (type === TYPE_QUOTE) {
      debug('responding to quote request')
      const err = new Error('quote response')
      err.status = 418
      err.code = 'F99'
      err.data = encrypt(secret, writeUInt64(Buffer.alloc(8), transfer.amount, 0)).toString('base64')
      err.triggeredAt = new Date().toISOString()
      throw err
    } else if (type === TYPE_CHUNK || type === TYPE_LAST_CHUNK) {
      const fulfillment = dataToFulfillment(secret, transfer.data, transfer.condition)
      const lastChunk = (type === TYPE_LAST_CHUNK)
      const paymentId = decryptedData.slice(1, 17)
      const destinationAmount = readUInt64(decryptedData, 17)

      let record = payments[paymentId]
      if (!record) {
        record = payments[paymentId] = {
          received: Big(0),
          expected: MAX_UINT_64,
          finished: false
        }
      }
      if (destinationAmount.gt(0)) {
        record.expected = destinationAmount
      }

      // If too much arrived, respond with error saying how much we're waiting
      // for and how much came in on this transfer
      const received = record.received.plus(transfer.amount)
      // TODO make the acceptable overage amount configurable
      if (record.finished || received.gt(record.expected.times(1.01))) {
        debug(`receiver received too much. amount received before this chunk: ${record.received}, this chunk: ${transfer.amount}, expected: ${record.expected}`)
        const err = new Error('too much received')
        err.status = 422
        err.code = 'F99'
        const response = Buffer.alloc(16)
        writeUInt64(response, record.expected.minus(record.received), 0)
        writeUInt64(response, transfer.amount, 8)
        err.data = encrypt(secret, response).toString('base64')
        throw err
      }

      record.received = received
      record.finished = (lastChunk || received.gte(record.expected))
      ctx.fulfillment = fulfillment

      debug(`got ${record.finished ? 'last ' : ''}chunk of amount ${transfer.amount} for payment: ${paymentId.toString('hex')}. total received: ${received}`)

      // Wait to notify the receiver until the payment is finished or
      // they have specifically configured this receiver to notify on every chunk
      if (notifyEveryChunk || record.finished) {
        ctx.transfer = {
          amount: record.received.toString()
          // TODO put all of the data received from the sender here
        }
        await next()
      }

      // TODO accept user response data
      const response = Buffer.alloc(8, 0)
      writeUInt64(response, parseInt(record.received), 0)
      ctx.data = encrypt(secret, response)
    } else {
      const err = new Error('unknown type: ' + type)
      err.status = 400
      err.code = 'F06'
      err.triggeredAt = new Date().toISOString()
      throw err
    }
  }
}

function readUInt64 (buffer, offset) {
  const high = buffer.readUInt32BE(offset)
  const low = buffer.readUInt32BE(offset + 4)
  return Big(high).times(0x100000000).plus(low)
}

function writeUInt64 (buffer, val, offset) {
  const big = Big(val)
  const high = big.div(0x100000000).round(0)
  const low = big.mod(0x100000000).round(0)
  buffer.writeUInt32BE(parseInt(high), offset)
  buffer.writeUInt32BE(parseInt(low), offset + 4)
  return buffer
}

function dataToFulfillment (secret, data, originalCondition) {
  const key = hmac(secret, PSK_FULFILLMENT_STRING)
  const fulfillment = hmac(key, data)
  const condition = hash(fulfillment)
  if (originalCondition && !condition.equals(Buffer.from(originalCondition, 'base64'))) {
    const err = new Error('unable to regenerate fulfillment')
    err.code = 'F05'
    err.triggeredAt = new Date().toISOString()
    throw err
  }
  return fulfillment
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

function encrypt (secret, data) {
  const buffer = Buffer.from(data, 'base64')
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

function decrypt (secret, data) {
  const buffer = Buffer.from(data, 'base64')
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

exports.Sender = PskSender
exports.receiver = receiver
