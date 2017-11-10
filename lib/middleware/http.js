'use strict'

const fetch = require('node-fetch')
const url = require('url')
const getRawBody = require('raw-body')
const Debug = require('debug')

const BODY_SIZE_LIMIT = '1mb'

function client (opts) {
  const debug = Debug('ilp3-http:client')
  if (!opts) {
    opts = {}
  }
  const streamData = !!opts.streamData

  return async function (ctx, next) {
    const transfer = ctx.transfer
    const connector = ctx.connector

    debug('sending transfer to:', connector, Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }))
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
    if (parsedUri.username && parsedUri.password) {
      const basicAuth = Buffer.from(`${parsedUri.username}:${parsedUri.password}`, 'utf8').toString('base64')
      headers['Authorization'] = `Basic ${basicAuth}`
    } else if (parsedUri.username) {
      headers['Authorization'] = `Bearer ${parsedUri.username}`
    }

    let response
    try {
      response = await fetch(url.format(parsedUri, { auth: false }), {
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
