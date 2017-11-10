'use strict'

const assert = require('assert')
const Debug = require('debug')
const Macaroon = require('macaroon')
const Big = require('big.js')
const url = require('url')

const MACAROON_EXPIRY_DURATION = 2000

function authenticator ({ secret }) {
  const debug = Debug('ilp3-macaroons:authenticator')
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

function timeLimiter (opts) {
  const debug = Debug('ilp3-macaroons:timeLimiter')
  if (!opts) {
    opts = {}
  }
  const duration = opts.duration || MACAROON_EXPIRY_DURATION

  return (ctx, next) => {
    if (!ctx.connector) {
      debug('connector is not set, skipping')
      return next()
    }

    const parsedUri = new url.URL(ctx.connector)
    let macaroon
    try {
      macaroon = Macaroon.importMacaroon(parsedUri.username)
      const expiryTimestamp = new Date(Date.now() + duration).toISOString()
      macaroon.addFirstPartyCaveat(`time < ${expiryTimestamp}`)
      debug('added caveat to macaroon so it expires at:', expiryTimestamp)
    } catch (err) {
      debug('token is not a macaroon, using plain token')
      // token is not a macaroon
      return token
    }

    ctx.connector = url.format(Object.assign(parsedUri, {
      username: base64url(macaroon.exportBinary())
    }))

    return next()
  }
}

function base64url (buffer) {
  return Buffer.from(buffer, 'base64')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}


exports.authenticator = authenticator
exports.timeLimiter = timeLimiter