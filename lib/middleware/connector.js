'use strict'

const debug = require('debug')('ilp3-connector')
const fetch = require('node-fetch')
const Big = require('big.js')

const FIXERIO_API = 'https://api.fixer.io/latest'
const COINMARKETCAP_API = 'https://api.coinmarketcap.com/v1/ticker/?convert=EUR&limit=25'

// TODO split the forwarder part from the send functionality (so it works with other ledger protocols)
function simple (opts) {
  const routes = opts.routes
  const path = opts.path || '*'
  const minMessageWindow = opts.minMessageWindow || 1000
  const spread = opts.spread || 0
  const secret = opts.secret
  let connected = false
  let rates

  async function connect () {
    rates = await getExchangeRates()
    connected = true
    debug('connected')
  }

  // TODO is it too janky to set this off in the background when it's created?
  const connectedPromise = connect()

  return async function forwardPayments (ctx, next) {
    if (!connected) {
      await connectedPromise
    }
    const transfer = ctx.transfer
    const account = ctx.account || {}

    let longestPrefix = null
    for (let prefix in routes) {
      if (transfer.destination.startsWith(prefix) && (!longestPrefix || prefix.length > longestPrefix.length)) {
        longestPrefix = prefix
      }
    }
    if (!longestPrefix) {
      debug('no route found for destination:', transfer.destination)
      return ctx.throw(404, 'no route found')
    }
    debug(`longest prefix matching: ${transfer.destination} is: ${longestPrefix}`)
    const to = routes[longestPrefix].connector || longestPrefix
    const nextHop = routes[to]

    const rate = getRate({
      rates,
      routes,
      to,
      from: transfer.from,
      fromAccount: account,
      spread
    })
    debug(`applying rate of: ${rate} to transfer from: ${transfer.from} to: ${to}`)
    const nextAmount = Big(transfer.amount).times(rate).round(0, 0).toString()
    const outgoingTransfer = {
      amount: nextAmount,
      destination: transfer.destination,
      condition: transfer.condition,
      expiry: new Date(Date.parse(transfer.expiry) - minMessageWindow).toISOString(),
      data: transfer.data,
      to
    }

    // Update the transfer and pass control to the next handler
    ctx.transfer = outgoingTransfer
    debug('forwarding transfer to next connector:', Object.assign({}, outgoingTransfer, { data: '[Stream]' }))
    try {
      // If the outgoing transfer works, the fulfillment and data will be set
      // on the ctx and be picked up by the function that handled the incoming transfer initially
      await next()
      if (ctx.fulfillment) {
        debug(`responding to the sender with the fulfillment: ${ctx.fulfillment}`)
      }
    } catch (err) {
      if (err.code) {
        debug('got ILP error forwarding transfer:', Object.assign({}, outgoingTransfer, { data: '[Stream]' }) , {
          code: err.code,
          name: err.name,
          data: err.data,
          triggeredAt: err.triggeredAt
        })
      } else {
        debug('error forwarding transfer:', Object.assign({}, outgoingTransfer, { data: '[Stream]' }) , err)
      }
      throw err
    }
  }
}

function getRate ({ routes, rates, from, fromAccount = {}, to, spread = 0 }) {
  try {
    const fromRoute = routes[from] || {}
    const fromCurrency = fromAccount.currencyCode || fromRoute.currencyCode
    if (!fromCurrency) {
      throw new Error('Currency unknown for account: ' + from)
    }
    const fromScale = fromAccount.currencyScale || fromRoute.currencyScale
    if (!fromScale) {
      throw new Error('Currency scale unknown for account: ' + from)
    }
    const fromRate = rates[fromCurrency]
    if (!fromRate) {
      throw new Error('Rate unknown for currency: ' + fromCurrency)
    }
    if (!routes[to]) {
      throw new Error('Unknown destination: ' + to)
    }
    const toCurrency = routes[to].currencyCode
    if (!toCurrency) {
      throw new Error('Currency unknown for account: ' + to)
    }
    const toScale = routes[to].currencyScale
    if (!toScale) {
      throw new Error('Currency scale unknown for account: ' + to)
    }
    const toRate = rates[toCurrency]
    if (!toRate) {
      throw new Error('Rate unknown for currency: ' + toCurrency)
    }
    const exchangeRate = toRate.div(fromRate)
    const scaledRate = exchangeRate.times(Big(10).pow(toScale - fromScale))
    const markedUpRate = scaledRate.times(Big(1).minus(spread))
    return markedUpRate
  } catch (err) {
    debug(`error getting rate from ${from} to ${to}`, err)
    err.status = 404
    err.code = 'F02'
    err.triggeredAt = new Date().toISOString()
    throw err
  }
}

async function getExchangeRates () {
  debug('getting exchange rates from fixer.io and coinmarketcap')
  const results = await Promise.all([_getRatesFromFixerIo(), _getRatesFromCoinMarketCap()])
  return Object.assign({}, results[0], results[1])
}

async function _getRatesFromFixerIo () {
  const rates = {
    'EUR': Big(1)
  }
  debug('getting rates from fixer.io')
  const response = await fetch(FIXERIO_API)
  debug('got rates from fixer.io')
  const result = await response.json()
  for (let currency in result.rates) {
    rates[currency] = Big(result.rates[currency])
  }
  return rates
}

async function _getRatesFromCoinMarketCap () {
  const rates = {}
  debug('getting rates from coinmarketcap')
  const response = await fetch(COINMARKETCAP_API)
  const results = await response.json()
  debug('got rates from coinmarketcap')
  for (let result of results) {
    rates[result.symbol] = Big(result.price_eur)
  }
  return rates
}

exports.simple = simple
