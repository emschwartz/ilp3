'use strict'

const crypto = require('crypto')
const debug = require('debug')('ilp3-fulfillments:validator')

function validator () {
  return async function (ctx, next) {
    const transfer = ctx.incoming.transfer || ctx.outgoing.transfer
    const condition = Buffer.from(transfer.condition, 'base64')

    await next()

    if (ctx.fulfillment) {
      const fulfillment = Buffer.from(ctx.fulfillment, 'base64')
      if (!hash(fulfillment).equals(condition)) {
        const err = new Error(`fulfillment received does not match transfer condition. fulfillment: ${fulfillment.toString('base64')}, condition: ${condition.toString('base64')}`)
        err.status = 502
        err.code = 'T01' // TODO need error for "we got an invalid fulfillment"
        throw err
      } else {
        debug('fulfillment matches original transfer condition')
      }
    }
  }
}

function hash (fulfillment) {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(fulfillment, 'base64'))
  return h.digest()
}

exports.validator = validator
