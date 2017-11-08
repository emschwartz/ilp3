'use strict'

const debug = require('debug')('ilp3-connector')
const Router = require('koa-router')
const fetch = require('node-fetch')
const Big = require('big.js')
const ILP3 = require('./ilp3')

const FIXERIO_API = 'https://api.fixer.io/latest'
const COINMARKETCAP_API = 'https://api.coinmarketcap.com/v1/ticker/?convert=EUR&limit=25'

function createConnector (opts) {
  const routes = opts.routes
  const path = opts.path || '*'
  const minMessageWindow = opts.minMessageWindow || 1000
  const spread = opts.spread || 0
  const secret = opts.secret
  let rates

  const connector = ILP3.createReceiver({
    secret,
    // This will make transfer.data be a stream, which node-fetch will pipe to the destination
    streamData: true
  })
  const router = new Router()
  router.post(path, async (ctx, next) => {
    // TODO don't make this call in the flow of the payment
    if (!rates) {
      const results = await Promise.all([_getRatesFromFixerIo(), _getRatesFromCoinMarketCap()])
      rates = Object.assign({}, results[0], results[1])
    }

    const from = ctx.state.account
    if (!routes[from]) {
      return ctx.throw(401)
    }

    const transfer = ctx.state.transfer

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
    const nextHop = routes[longestPrefix]

    const rate = getRate({
      rates,
      routes,
      to: longestPrefix,
      from: from,
      spread
    })
    debug(`applying rate of: ${rate} to transfer from: ${from} to: ${longestPrefix}`)
    const nextAmount = Big(transfer.amount).times(rate).round(0, 0).toString()
    const outgoingTransfer = {
      amount: nextAmount,
      destination: transfer.destination,
      condition: transfer.condition,
      expiry: new Date(Date.parse(transfer.expiry) - minMessageWindow).toISOString(),
      data: transfer.data
    }

    try {
      debug('forwarding transfer to next connector:', nextHop.connector, Object.assign({}, outgoingTransfer, { data: '[Stream]' }))
      const result = await ILP3.send({
        connector: nextHop.connector,
        transfer: outgoingTransfer
      })
      debug('responding to sender with fulfillment')
      ctx.state.fulfillment = result.fulfillment
      ctx.state.data = result.data
    } catch (err) {
      debug('error forwarding payment to: ' + nextHop.connector, err)
      return ctx.throw(err)
    }
  })
  connector.use(router.routes())
  return connector
}

function getRate ({ routes, rates, from, to, spread = 0 }) {
  const fromCurrency = routes[from].currency
  const fromScale = routes[from].scale
  const fromRate = rates[fromCurrency]
  if (!fromRate) {
    throw new Error('Rate unknown for currency: ' + fromCurrency)
  }
  const toCurrency = routes[to].currency
  const toScale = routes[to].scale
  const toRate = rates[toCurrency]
  if (!toRate) {
    throw new Error('Rate unknown for currency: ' + toCurrency)
  }
  const exchangeRate = toRate.div(fromRate)
  const scaledRate = exchangeRate.times(Big(10).pow(toScale - fromScale))
  const markedUpRate = scaledRate.times(Big(1).minus(spread))
  return markedUpRate
}

async function _getRatesFromFixerIo () {
  const rates = {
    'EUR': Big(1)
  }
  const result = await (await fetch(FIXERIO_API)).json()
  for (let currency in result.rates) {
    rates[currency] = Big(result.rates[currency])
  }
  return rates
}

async function _getRatesFromCoinMarketCap () {
  const rates = {}
  const results = await (await fetch(COINMARKETCAP_API)).json()
  for (let result of results) {
    rates[result.symbol] = Big(result.price_eur)
  }
  return rates
}

exports.createConnector = createConnector
