'use strict'

const fetch = require('node-fetch')
const url = require('url')
const getRawBody = require('raw-body')
const Debug = require('debug')

const BODY_SIZE_LIMIT = '1mb'
const STANDARD_HEADERS = ['ilp-amount', 'ilp-condition', 'ilp-expiry', 'ilp-destination']

function client (opts) {
  const debug = Debug('ilp3-http:client')
  if (!opts) {
    opts = {}
  }
  const streamData = !!opts.streamData
  const routes = opts.routes || {}

  return async function (ctx, next) {
    const transfer = ctx.outgoing.transfer
    if (!transfer) {
      debug('no outgoing transfer, skipping')
      return next()
    }
    const connector = ctx.outgoing.account.uri || (routes[transfer.to] && routes[transfer.to].uri)
    if (!connector) {
      const err = new Error('no route to destination: ' + transfer.to)
      err.status = 404
      err.code = 'F02'
      err.triggeredAt = new Date().toISOString()
      throw err
    }

    const headers = {
      'ILP-Amount': transfer.amount,
      'ILP-Expiry': transfer.expiry,
      'ILP-Condition': transfer.condition,
      'ILP-Destination': transfer.destination,
      'User-Agent': '',
      'Content-Type': 'application/octet-stream'
    }

    if (transfer.extensions) {
      for (let key in transfer.extensions) {
        headers['ILP-' + key.replace('_', '-')] = transfer.extensions[key]
      }
    }
    debug('sending transfer to:', connector, Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }))

    // Parse authentication from URI
    const parsedUri = new url.URL(connector)
    if (parsedUri.username && parsedUri.password) {
      const basicAuth = Buffer.from(`${parsedUri.username}:${parsedUri.password}`, 'utf8').toString('base64')
      headers['Authorization'] = `Basic ${basicAuth}`
    } else if (parsedUri.username) {
      headers['Authorization'] = `Bearer ${parsedUri.username}`
    }

    let response
    try {
      // TODO use http(s).Agent to use keepalive
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
      })),
      extensions: {}
    }

    for (let header in ctx.request.headers) {
      if (header.startsWith('ilp-') && !STANDARD_HEADERS.includes(header)) {
        const key = header.replace('ilp-', '').replace('-', '_')
        transfer.extensions[key] = ctx.request.headers[header]
      }
    }

    debug('got transfer:', Object.assign({}, transfer, { data: (streamData ? '[Stream]' : transfer.data.toString('base64')) }))
    if (!ctx.incoming.transfer) {
      ctx.incoming.transfer = {}
    }
    Object.assign(ctx.incoming.transfer, transfer)

    try {
      await next()
    } catch (err) {
      if (!err.code) {
        err.code = 'T00'
        debug('error handling incoming http request:', err)
      }
      ctx.status = err.status || 500
      const ilpError = {
        code: err.code,
        data: err.data,
        triggeredAt: err.triggeredAt || new Date().toISOString()
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
      ctx.set('ILP-Fulfillment', (typeof ctx.fulfillment === 'string' ? ctx.fulfillment : ctx.fulfillment.toString('base64')))
      ctx.body = ctx.data
    }
  }
}

exports.client = client
exports.parser = parser
