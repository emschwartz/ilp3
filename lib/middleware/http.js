'use strict'

const Macaroon = require('macaroon')
const fetch = require('node-fetch')
const url = require('url')
const getRawBody = require('raw-body')
const Debug = require('debug')

const BODY_SIZE_LIMIT = '1mb'
const MACAROON_EXPIRY_TIME = 2000

function client (opts) {
  const debug = Debug('ilp3-http:client')
  if (!opts) {
    opts = {}
  }
  const streamData = !!opts.streamData

  return async function (ctx, next) {
    const transfer = ctx.transfer
    const connector = ctx.connector

    debug('sending transfer:', Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }))
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

    ctx.fulfillment = fulfillment
    ctx.data = data
    return next()
  }
}

// TODO this should be under the macaroons middleware
function addTimeLimitIfMacaroon (token, expiry) {
  const debug = Debug('ilp3:httpSender')
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

function parser (opts) {
  const debug = Debug('ilp3-http:parser')
  if (!opts) {
    opts = {}
  }
  const streamData = !!opts.streamData

  return async (ctx, next) => {
    if (ctx.method.toLowerCase() !== 'post') {
      return next()
    }
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
    ctx.transfer = transfer

    await next()

    if (ctx.fulfillment) {
      debug('responding to sender with fulfillment')
      ctx.status = 200
      ctx.set('ILP-Fulfillment', ctx.fulfillment)
      ctx.body = ctx.data
    }
  }
}

exports.client = client
exports.parser = parser
