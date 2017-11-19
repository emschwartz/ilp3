const debug = require('debug')('ilp3-balance-tracker')
const Big = require('big.js')
const levelup = require('levelup')
const leveldown = require('leveldown')
const memdown = require('memdown')
const path = require('path')
const util = require('util')
const AsyncLock = require('async-lock')

// Make sure all balance updates are atomic
// (this only works within one process, but leveldb is only meant for one process anyway)
const lock = new AsyncLock()

// TODO increase balance on outgoing payment
function tracker (opts) {
  if (!opts) {
    opts = {}
  }
  const defaultMinBalance = Big(opts.defaultMinBalance || 0)
  const inMemory = !!opts.inMemory
  const dbPath = opts.dbPath || path.resolve(__dirname, '../..', 'balance-db')
  const down = opts.abstractLeveldown || (inMemory ? memdown() : leveldown(dbPath))
  const db = levelup(down)

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

        let balance
        try {
          balance = Big(await db.get(`balance ${transfer.from}`))
        } catch (err) {
          if (err.notFound) {
            balance = Big(0)
          } else {
            debug('got unexpected error reading from db:', err)
            throw err
          }
        }

        // Other middleware can instruct the balance tracker to adjust the account's balance
        // (for example, a payment channel middleware would adjust the balance upon receiving a new paychan update)
        const adjustBalance = Big(account.adjustBalance || 0)
        debug(`applying balance adjustment: ${(Big(account.adjustBalance).gt(0) ? '+' + account.adjustBalance : account.adjustBalance)} for account: ${transfer.from}`)

        const newBalance = balance.plus(adjustBalance).minus(transfer.amount)
        if (newBalance.lt(minBalance)) {
          // Apply the balance adjustment before throwing the error
          await updateBalance(db, transfer.from, account.adjustBalance)

          debug(`transfer would put account under minimum balance. account: ${transfer.from}, current balance: ${balance}, minimum balance: ${minBalance}, transfer amount: ${transfer.amount}`)
          const err = new Error('transfer would put account under minimum balance')
          err.status = 403
          err.code = 'T04'
          err.triggeredAt = new Date().toISOString()
          throw err
        }

        // Update the account balance in parallel to calling next()
        async function debitAccount () {
          balance = await updateBalance(db, transfer.from, adjustBalance.minus(transfer.amount))
          debug(`debiting account: ${transfer.from} for: ${transfer.amount}, balance is now: ${balance}`)
        }

        // Roll back the balance change if the transfer is rejected
        try {
          await Promise.all([
            next(),
            debitAccount()
          ])
        } catch (err) {
          balance = await updateBalance(db, transfer.from, transfer.amount)
          debug(`incoming transfer failed, crediting account: ${transfer.from} by: ${transfer.amount}, balance is now: ${balance}`)
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
          const balance = await updateBalance(db, transfer.to, transfer.amount)
          debug(`crediting account: ${transfer.to} by: ${transfer.amount}, balance is now: ${balance}`)
        }
      }
    }
  }
}

async function updateBalance (db, account, delta) {
  let balance
  await lock.acquire(account, async () => {
    try {
      balance = Big(await db.get(`balance ${account}`))
    } catch (err) {
      if (err.notFound) {
        balance = Big(0)
      } else {
        debug('got unexpected error reading from db:', err)
        throw err
      }
    }
    balance = balance.plus(delta)
    await db.put(`balance ${account}`, balance.toString())
  })
  return balance
}

exports.tracker = tracker
