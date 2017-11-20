'use strict'

const debug = require('debug')('ilp3-balance-tracker')
const Big = require('big.js')
const levelup = require('levelup')

// TODO increase balance on outgoing payment
function tracker (opts) {
  if (!opts) {
    opts = {}
  }
  const defaultMinBalance = Big(opts.defaultMinBalance || 0)
  const inMemory = !!opts.inMemory
  const db = levelup(opts.leveldown)

  // Read balances from the db once, then keep them in memory and
  // only write to the db when the balance changes
  const balances = {}

  async function ensureRecordExists (account) {
    if (!balances[account]) {
      try {
        balances[account] = Big(await db.get(`balance ${account}`))
        debug(`loaded balance: ${balances[account]} from db for account: ${account}`)
      } catch (err) {
        if (err.notFound) {
          debug(`creating new entry for account ${account}`)
          balances[account] = Big(0)
        } else {
          debug('got unexpected error reading to db:', err)
          throw err
        }
      }
    }
  }

  return {
    incoming: function () {
      return async function (ctx, next) {
        const account = ctx.incoming.account
        const minBalance = (account.minBalance || account.minBalance === 0 ? account.minBalance : defaultMinBalance)
        const transfer = ctx.incoming.transfer
        if (!transfer) {
          debug('cannot use balance tracker without middleware that sets ctx.incoming.transfer')
          return ctx.throw(500, new Error('no transfer attached to context'))
        }
        if (!transfer.from) {
          debug('cannot use balance tracker if transfer.from is not set')
          throw new Error('cannot use balance tracker if transfer.from is not set')
        }

        await ensureRecordExists(transfer.from)

        // Other middleware can instruct the balance tracker to adjust the account's balance
        // (for example, a payment channel middleware would adjust the balance upon receiving a new paychan update)
        const adjustBalance = Big(account.adjustBalance || 0)
        if (!adjustBalance.eq(0)) {
          balances[transfer.from] = balances[transfer.from].plus(account.adjustBalance)
          debug(`applying balance adjustment: ${(Big(account.adjustBalance).gt(0) ? '+' + account.adjustBalance : account.adjustBalance)} for account: ${transfer.from}, balance is now: ${balances[transfer.from]}`)
        }

        const newBalance = balances[transfer.from].minus(transfer.amount)
        if (newBalance.lt(minBalance)) {
          // Apply the balance adjustment before throwing the error
          if (account.adjustBalance && !Big(account.adjustBalance).eq(0)) {
            await db.put(`balance ${transfer.from}`, balances[transfer.from].toString())
          }

          debug(`transfer would put account under minimum balance. account: ${transfer.from}, current balance: ${balances[transfer.from]}, minimum balance: ${minBalance}, transfer amount: ${transfer.amount}`)
          const err = new Error('transfer would put account under minimum balance')
          err.status = 403
          err.code = 'T04'
          err.triggeredAt = new Date().toISOString()
          throw err
        }

        balances[transfer.from] = newBalance

        // Roll back the balance change if the transfer is rejected
        try {
          await Promise.all([
            next(),
            db.put(`balance ${transfer.from}`, balances[transfer.from].toString())
          ])
        } catch (err) {
          balances[transfer.from] = balances[transfer.from].plus(transfer.amount)
          await db.put(`balance ${transfer.from}`, balances[transfer.from].toString())
          debug(`incoming transfer failed, crediting account: ${transfer.from} by: ${transfer.amount}, balance is now: ${balances[transfer.from]}`)
          throw err
        }
      }
    },
    outgoing: function () {
      return async function (ctx, next) {
        const transfer = ctx.outgoing.transfer
        if (!transfer) {
          debug('cannot use balance tracker without middleware that sets ctx.outgoing.transfer')
          return ctx.throw(500, new Error('no transfer attached to context'))
        }

        // Only adjust the outgoing balance if the transfer succeeds
        // (if we're enforcing the minimum balance, we don't want peers to be able to
        // make their balance seem higher if they have a bunch of prepared payments)
        await next()

        // Credit the outgoing account if the transfer was fulfilled
        if (ctx.fulfillment) {
          await ensureRecordExists(transfer.to)

          balances[transfer.to] = balances[transfer.to].plus(transfer.amount)
          debug(`crediting account: ${transfer.to} by: ${transfer.amount}, balance is now: ${balances[transfer.to]}`)
          await db.put(`balance ${transfer.to}`, balances[transfer.to].toString())
        }
      }
    }
  }
}

exports.tracker = tracker
