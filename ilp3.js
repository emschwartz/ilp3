'use strict'

const assert = require('assert')
const url = require('url')
const fetch = require('node-fetch')
const Koa = require('koa')
const getRawBody = require('raw-body')
const Debug = require('debug')
const Macaroon = require('macaroon')
const Big = require('big.js')

const BODY_SIZE_LIMIT = '1mb'
const MACAROON_EXPIRY_TIME = 2000

async function send ({ connector, transfer, streamData = false }) {
  const debug = Debug('ilp3:send')
  if (streamData) {
    debug('sending transfer:', Object.assign({}, transfer, { data: '[Stream]' }))
  } else {
    debug('sending transfer:', Object.assign({}, transfer, { data: transfer.data.toString('base64') }))
  }
  const headers = Object.assign({
    'ILP-Amount': transfer.amount,
    'ILP-Expiry': transfer.expiry,
    'ILP-Condition': transfer.condition,
    'ILP-Destination': transfer.destination,
    'User-Agent': '',
    'Content-Type': 'application/octet-stream'
  }, transfer.additionalHeaders || {})

  // Parse authentication from URI
  const parsedUri = new url.URL(connector)
  const auth = (parsedUri.password ? parsedUri.username + ':' + parsedUri.password : parsedUri.username)
  const authToken = addTimeLimitIfMacaroon(auth, Date.now() + MACAROON_EXPIRY_TIME)
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }
  const uri = url.format(parsedUri, { auth: false })

  let response
  try {
    response = await fetch(uri, {
      method: 'POST',
      headers,
      body: transfer.data,
      compress: false
    })
  } catch (err) {
    debug('error sending transfer', err)
    throw err
  }
  if (!response.ok) {
    throw new Error(`Error sending transfer: ${response.status} ${response.statusText}`)
  }

  const fulfillment = response.headers.get('ilp-fulfillment')
  const contentType = response.headers.get('content-type')
  const data = (streamData ? response.body : await response.buffer())
  if (streamData) {
    debug(`got fulfillment: ${fulfillment} and data: [Stream]`)
  } else {
    debug(`got fulfillment: ${fulfillment} and data:`, data.toString('base64'))
  }
  return {
    fulfillment,
    data
  }
}

function addTimeLimitIfMacaroon (token, expiry) {
  const debug = Debug('ilp3-send:macaroon')
  let macaroon
  try {
    macaroon = Macaroon.importMacaroon(token)
    const expiryTimestamp = new Date(expiry).toISOString()
    macaroon.addFirstPartyCaveat(`time < ${expiryTimestamp}`)
    debug('added caveat to macaroon so it expires at:', expiryTimestamp)
    return Buffer.from(macaroon.exportBinary()).toString('base64')
  } catch (err) {
    debug('token is not a macaroon, using plain token')
    // token is not a macaroon
    return token
  }
}

// TODO should this be part of ILP3 or an extension?
function macaroonAuthenticator ({ secret }) {
  const debug = Debug('ilp3-macaroon:verifier')
  assert(secret, 'secret is required')
  assert(Buffer.from(secret, 'base64').length >= 32, 'secret must be at least 32 bytes')

  return async (ctx, next) => {
    try {
      const encoded = ctx.request.headers.authorization.replace(/^bearer /i, '')
      const macaroon = Macaroon.importMacaroon(encoded)
      const account = Buffer.from(macaroon.identifier).toString('utf8')
      debug('macaroon is for account:', account)
      let minBalance = null
      macaroon.verify(secret, (caveat) => {
        if (caveat.startsWith('time < ')) {
          const expiry = Date.parse(caveat.replace('time < ', ''))
          if (Date.now() >= expiry) {
            throw new Error('macaroon is expired')
          }
        } else if (caveat.startsWith('minBalance ')) {
          minBalance = Big(caveat.replace('minBalance ', ''))
        } else {
          throw new Error('unsupported caveat')
        }
      })
      debug('macaroon passed validation')
      if (!ctx.state.account) {
        ctx.state.account = {}
      }
      ctx.state.account.prefix = account
      ctx.state.account.minBalance = minBalance
    } catch (err) {
      debug('invalid macaroon', err)
      return ctx.throw(401, 'invalid macaroon')
    }
    return next()
  }
}

function transfersOverHttp (opts) {
  if (!opts) {
    opts = {}
  }
  const streamData = !!opts.streamData

  return async (ctx, next) => {
    if (ctx.method.toLowerCase() !== 'post') {
      return next()
    }
    const debug = Debug('ilp3:receiver')
    const data = (streamData ? ctx.req : await getRawBody(ctx.req, {
      limit: BODY_SIZE_LIMIT
    }))
    const transfer = {
      amount: ctx.request.headers['ilp-amount'],
      expiry: ctx.request.headers['ilp-expiry'],
      condition: ctx.request.headers['ilp-condition'],
      destination: ctx.request.headers['ilp-destination'],
      data
    }

    if (streamData) {
      debug('got transfer:', Object.assign({}, transfer, { data: '[Stream]' }))
    } else {
      debug('got transfer:', Object.assign({}, transfer, { data: transfer.data.toString('base64') }))
    }
    // TODO validate transfer details
    ctx.state.transfer = transfer

    await next()

    if (ctx.state.fulfillment) {
      debug('responding to sender with fulfillment')
      ctx.status = 200
      ctx.set('ILP-Fulfillment', ctx.state.fulfillment)
      ctx.body = ctx.state.data
    }
  }
}

// TODO increase balance on outgoing payment
function inMemoryBalanceTracker (opts) {
  const debug = Debug('ilp3-balance-tracker')
  if (!opts) {
    opts = {}
  }
  const defaultMinBalance = Big(opts.defaultMinBalance || 0)
  const balances = {}

  return async function (ctx, next) {
    const account = ctx.state.account
    const transfer = ctx.state.transfer
    if (!account) {
      debug('cannot use inMemoryBalanceTracker without middleware that sets ctx.state.account')
      return ctx.throw(500, new Error('no account record attached to context'))
    }
    if (!transfer) {
      debug('cannot use inMemoryBalanceTracker without middleware that sets ctx.state.transfer')
      return ctx.throw(500, new Error('no transfer attached to context'))
    }

    if (!balances[account.prefix]) {
      balances[account.prefix] = Big(0)
    }

    const newBalance = balances[account.prefix].minus(transfer.amount)
    const minBalance = account.minBalance || defaultMinBalance
    if (newBalance.lt(minBalance)) {
      debug(`transfer would put account under minimum balance. account: ${account.prefix}, current balance: ${balances[account.prefix]}, minimum balance: ${minBalance}, transfer amount: ${transfer.amount}`)
      return ctx.throw(403, new Error('transfer would put account under minimum balance'))
    } else {
      balances[account.prefix] = newBalance
    }

    // Roll back the balance change if the transfer is rejected
    try {
      await next()
    } catch (err) {
      balances[account.prefix] = balances[account.prefix].plus(transfer.amount)
      throw err
    }
  }
}

exports.send = send
exports.transfersOverHttp = transfersOverHttp
exports.macaroonAuthenticator = macaroonAuthenticator
exports.inMemoryBalanceTracker = inMemoryBalanceTracker
