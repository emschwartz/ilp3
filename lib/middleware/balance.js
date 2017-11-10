const debug = require('debug')('ilp3-balance-tracker')
const Big = require('big.js')

// TODO increase balance on outgoing payment
function inMemoryTracker (opts) {
  if (!opts) {
    opts = {}
  }
  const defaultMinBalance = Big(opts.defaultMinBalance || 0)
  const balances = {}

  return async function (ctx, next) {
    const account = ctx.state.account
    const transfer = ctx.transfer
    if (!account) {
      debug('cannot use inMemoryBalanceTracker without middleware that sets ctx.state.account')
      return ctx.throw(500, new Error('no account record attached to context'))
    }
    if (!transfer) {
      debug('cannot use inMemoryBalanceTracker without middleware that sets ctx.state.transfer')
      return ctx.throw(500, new Error('no transfer attached to context'))
    }

    if (!balances[account.prefix]) {
      balances[account.prefix] = Big(0)
    }

    const newBalance = balances[account.prefix].minus(transfer.amount)
    const minBalance = account.minBalance || defaultMinBalance
    if (newBalance.lt(minBalance)) {
      debug(`transfer would put account under minimum balance. account: ${account.prefix}, current balance: ${balances[account.prefix]}, minimum balance: ${minBalance}, transfer amount: ${transfer.amount}`)
      return ctx.throw(403, new Error('transfer would put account under minimum balance'))
    } else {
      balances[account.prefix] = newBalance
    }

    // Roll back the balance change if the transfer is rejected
    try {
      await next()
    } catch (err) {
      balances[account.prefix] = balances[account.prefix].plus(transfer.amount)
      throw err
    }
  }
}

exports.inMemoryTracker = inMemoryTracker
