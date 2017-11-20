'use strict'

const levelup = require('levelup')
const Big = require('big.js')
const debug = require('debug')('ilp3-bandwidth-adjuster')

function adjuster (opts) {
  if (!opts) {
    opts = {}
  }
  const db = levelup(opts.leveldown)
  const increaseRatio = Big(1).plus(opts.increaseRatio || 0)
  const minimum = opts.maximum && Big(0).minus(opts.maximum)

  const minBalances = {}

  return async function (ctx, next) {
    const { from, amount } = ctx.incoming.transfer
    if (!ctx.incoming.account) {
      ctx.incoming.account = {}
    }

    if (!minBalances[from]) {
      try {
        minBalances[from] = Big(await db.get(from))
        debug(`loaded minBalance: ${minBalances[from]} from db for from: ${from}`)
      } catch (err) {
        if (err.notFound) {
          debug(`creating new entry for from ${from}`)
          minBalances[from] = Big(ctx.incoming.account.minBalance || 0)
        } else {
          debug('got unexpected error reading to db:', err)
          throw err
        }
      }
    }

    if (minimum && minBalances[from].lt(minimum)) {
      minBalances[from] = minimum
      await db.put(from, minBalances[from].toString())
    }

    ctx.incoming.account.minBalance = minBalances[from].toString()

    await next()

    if (ctx.fulfillment) {
      const newMinimum = minBalances[from]
        .minus(increaseRatio.times(amount))
        .round(0, 0)
      if (!newMinimum.eq(minBalances[from]) && (!minimum || newMinimum.gte(minimum))) {
        minBalances[from] = newMinimum
        debug(`lowering minBalance to ${minBalances[from]} for account ${from}`)
        await db.put(from, minBalances[from].toString())
      }
    }
  }
}

exports.adjuster = adjuster
