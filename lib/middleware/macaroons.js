'use strict'

const assert = require('assert')
const debug = require('debug')('ilp3-macaroons')
const Macaroon = require('macaroon')
const Big = require('big.js')

function authenticator ({ secret }) {
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

exports.authenticator = authenticator
