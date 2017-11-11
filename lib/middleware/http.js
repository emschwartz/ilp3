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
  const routes = opts.routes || {}

  return async function (ctx, next) {
    const transfer = ctx.transfer
    const connector = ctx.connector || routes[transfer.to].uri
    if (!connector) {
      return ctx.throw(404, new Error('no route to destination: ' + transfer.to))
    }

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
      const err = new Error(`Error sending transfer: ${response.status} ${response.statusText}`)
      const body = await response.json()
      err.data = body.data
      err.code = body.code
      err.triggeredAt = body.triggeredAt
      throw err
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
    // TODO validate transfer details
    const transfer = {
      amount: ctx.request.headers['ilp-amount'],
      expiry: ctx.request.headers['ilp-expiry'],
      condition: ctx.request.headers['ilp-condition'],
      destination: ctx.request.headers['ilp-destination'],
      data: (streamData ? ctx.req : await getRawBody(ctx.req, {
        limit: BODY_SIZE_LIMIT
      }))
    }

    debug('got transfer:', Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }))
    if (!ctx.transfer) {
      ctx.transfer = {}
    }
    Object.assign(ctx.transfer, transfer)

    try {
      await next()
    } catch (err) {
      if (!err.code) {
        debug('error handling incoming http request:', err)
        throw err
      }
      ctx.status = err.status || 500
      const ilpError = {
        code: err.code,
        data: err.data,
        triggeredAt: err.triggeredAt
      }
      debug('got ILP error for transfer:',
        Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }),
        ilpError)
      ctx.body = ilpError
      // TODO should we emit an error, as recommended by Koa? https://github.com/koajs/koa/wiki/Error-Handling
      return
    }

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
