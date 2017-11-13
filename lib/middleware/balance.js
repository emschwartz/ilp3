const debug = require('debug')('ilp3-balance-tracker')
const Big = require('big.js')

// TODO increase balance on outgoing payment
function inMemoryTracker (opts) {
  if (!opts) {
    opts = {}
  }
  const defaultMinBalance = Big(opts.defaultMinBalance || 0)
  const balances = {}

  return {
    incoming: function () {
      return async function (ctx, next) {
        const transfer = ctx.transfer
        if (!transfer) {
          debug('cannot use balance tracker without middleware that sets ctx.transfer')
          return ctx.throw(500, new Error('no transfer attached to context'))
        }
        if (!transfer.from) {
          debug('cannot use balance tracker if transfer.from is not set')
          throw new Error('cannot use balance tracker if transfer.from is not set')
        }

        // Other middleware can instruct the balance tracker to adjust the account's balance
        // (for example, a payment channel middleware would adjust the balance upon receiving a new paychan update)
        const adjustBalance = ctx.adjustBalance || 0

        const account = ctx.state.accounts && ctx.state.accounts[transfer.from] || {}

        if (!balances[transfer.from]) {
          balances[transfer.from] = Big(0)
        }

        const newBalance = balances[transfer.from]
          .minus(transfer.amount)
          .plus(adjustBalance)
        const minBalance = account.minBalance || defaultMinBalance
        if (newBalance.lt(minBalance)) {
          debug(`transfer would put account under minimum balance. account: ${transfer.from}, current balance: ${balances[transfer.from]}, minimum balance: ${minBalance}, transfer amount: ${transfer.amount}`)
          const err = new Error('transfer would put account under minimum balance')
          err.status = 403
          err.code = 'T04'
          err.triggeredAt = new Date().toISOString()
          throw err
        } else {
          balances[transfer.from] = newBalance
        }
        debug(`debiting account: ${transfer.from}, balance is now: ${newBalance}`)

        // Roll back the balance change if the transfer is rejected
        try {
          await next()
        } catch (err) {
          balances[transfer.from] = balances[transfer.from].plus(transfer.amount)
          debug(`incoming transfer failed, crediting account: ${transfer.from} balance back to: ${balances[transfer.from]}`)
          throw err
        }
      }
    },
    outgoing: function () {
      return async function (ctx, next) {
        const transfer = ctx.transfer
        if (!transfer) {
          debug('cannot use balance tracker without middleware that sets ctx.transfer')
          return ctx.throw(500, new Error('no transfer attached to context'))
        }

        // Only adjust the outgoing balance if the transfer succeeds
        // (if we're enforcing the minimum balance, we don't want peers to be able to
        // make their balance seem higher if they have a bunch of prepared payments)
        await next()

        if (ctx.fulfillment) {
          if (!balances[transfer.to]) {
            balances[transfer.to] = Big(0)
          }
          balances[transfer.to] = balances[transfer.to].plus(transfer.amount)
          debug(`crediting account: ${transfer.to}, balance is now: ${balances[transfer.to]}`)
        }
      }
    }
  }
}

exports.inMemoryTracker = inMemoryTracker
