'use strict'

const debug = require('debug')('ilp3-connector')
const fetch = require('node-fetch')
const Big = require('big.js')
const assert = require('assert')
const levelup = require('levelup')

const FIXERIO_API = 'https://api.fixer.io/latest'
const COINMARKETCAP_API = 'https://api.coinmarketcap.com/v1/ticker/?convert=EUR&limit=25'

class SimpleConnector {
  constructor (opts) {
    if (!opts) {
      opts = {}
    }
    this.minMessageWindow = opts.minMessageWindow || 1000
    this.spread = opts.spread || 0
    this.db = levelup(opts.leveldown)

    this.routes = {}
    this.connected = false
    this.rates = null
  }

  async addRoute (prefix, route) {
    if (typeof prefix === 'object') {
      route = prefix
      prefix = route.address || route.prefix
    }
    assert(route.uri, 'route uri is required')
    assert(route.currencyCode, 'route currencyCode is required')
    assert(route.currencyScale, 'route currencyScale is required')

    debug('adding route for prefix:', prefix)
    this.routes[prefix] = route
    await this.db.put(prefix, JSON.stringify(route))
  }

  async connect () {
    await Promise.all([
      this._loadRoutesFromDb(),
      (async () => {
        this.rates = await getExchangeRates()
      })()])
    this.connected = true
    debug('connected')
  }

  middleware () {
    return this._forwardPayment.bind(this)
  }

  async _forwardPayment (ctx, next) {
    if (!this.connected) {
      await this.connect()
    }
    const transfer = ctx.incoming.transfer
    const account = ctx.incoming.account

    let longestPrefix = null
    for (let prefix in this.routes) {
      if (transfer.destination.startsWith(prefix) && (!longestPrefix || prefix.length > longestPrefix.length)) {
        longestPrefix = prefix
      }
    }
    if (!longestPrefix) {
      debug('no route found for destination:', transfer.destination)
      const err = new Error('no route found')
      err.status = 404
      err.code = 'F02'
      throw err
    }
    debug(`longest prefix matching: ${transfer.destination} is: ${longestPrefix}`)
    // If the route has a connector field, send it to that connector,
    // otherwise assume the longestPrefix is the address we should send to
    const to = this.routes[longestPrefix].connector || longestPrefix
    const nextHop = this.routes[to]

    const rate = this._getRate({
      to,
      from: transfer.from,
      fromAccount: account
    })
    debug(`applying rate of: ${rate} to transfer from: ${transfer.from} to: ${to}`)
    const nextAmount = Big(transfer.amount).times(rate).round(0, 0).toString()
    const outgoingTransfer = {
      amount: nextAmount,
      destination: transfer.destination,
      condition: transfer.condition,
      expiry: new Date(Date.parse(transfer.expiry) - this.minMessageWindow).toISOString(),
      data: transfer.data,
      to
    }

    ctx.outgoing.transfer = outgoingTransfer
    if (!ctx.outgoing.account) {
      ctx.outgoing.account = {}
    }
    ctx.outgoing.account.uri = nextHop.uri

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
        debug('got ILP error forwarding transfer:', Object.assign({}, outgoingTransfer, { data: '[Stream]' }), {
          code: err.code,
          name: err.name,
          data: err.data,
          triggeredAt: err.triggeredAt
        })
      } else {
        debug('error forwarding transfer:', Object.assign({}, outgoingTransfer, { data: '[Stream]' }), err)
      }
      throw err
    }
  }

  _getRate ({ from, fromAccount = {}, to }) {
    try {
      const fromRoute = this.routes[from] || {}
      const fromCurrency = fromAccount.currencyCode || fromRoute.currencyCode
      if (!fromCurrency) {
        throw new Error('Currency unknown for account: ' + from)
      }
      const fromScale = fromAccount.currencyScale || fromRoute.currencyScale
      if (!fromScale) {
        throw new Error('Currency scale unknown for account: ' + from)
      }
      const fromRate = this.rates[fromCurrency]
      if (!fromRate) {
        throw new Error('Rate unknown for currency: ' + fromCurrency)
      }
      if (!this.routes[to]) {
        throw new Error('Unknown destination: ' + to)
      }
      const toCurrency = this.routes[to].currencyCode
      if (!toCurrency) {
        throw new Error('Currency unknown for account: ' + to)
      }
      const toScale = this.routes[to].currencyScale
      if (!toScale) {
        throw new Error('Currency scale unknown for account: ' + to)
      }
      const toRate = this.rates[toCurrency]
      if (!toRate) {
        throw new Error('Rate unknown for currency: ' + toCurrency)
      }
      const exchangeRate = toRate.div(fromRate)
      const scaledRate = exchangeRate.times(Big(10).pow(toScale - fromScale))
      const markedUpRate = scaledRate.times(Big(1).minus(this.spread))
      return markedUpRate
    } catch (err) {
      debug(`error getting rate from ${from} to ${to}`, err)
      err.status = 404
      err.code = 'F02'
      err.triggeredAt = new Date().toISOString()
      throw err
    }
  }

  async _loadRoutesFromDb () {
    return new Promise((resolve, reject) => {
      this.db.createReadStream()
        .on('data', ({ key, value }) => {
          try {
            this.routes[key] = JSON.parse(value)
          } catch (err) {
            reject(err)
          }
        })
        .on('error', reject)
        .on('close', resolve)
        .on('end', resolve)
    })
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

exports.Simple = SimpleConnector
