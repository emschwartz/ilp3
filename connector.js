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
  const path = opts.path || '/'
  const minMessageWindow = opts.minMessageWindow || 1000
  const spread = opts.spread || 0
  let rates

  const connector = ILP3.createReceiver()
  const router = new Router()
  router.post(path, async (ctx, next) => {
    // TODO don't make this call in the flow of the payment
    if (!rates) {
      const results = await Promise.all([_getRatesFromFixerIo(), _getRatesFromCoinMarketCap()])
      rates = Object.assign({}, results[0], results[1])
    }

    // TODO get the from account from an auth token / macaroon
    const from = ctx.headers['authorization']
    if (!routes[from]) {
      ctx.throw(401)
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
      debug('forwarding transfer to next connector:', nextHop.connector, outgoingTransfer)
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
  //const result = (await request.get(FIXERIO_API)).body
  const result = {"base":"EUR","date":"2017-11-07","rates":{"AUD":1.5112,"BGN":1.9558,"BRL":3.7822,"CAD":1.4761,"CHF":1.1557,"CNY":7.675,"CZK":25.591,"DKK":7.4423,"GBP":0.88038,"HKD":9.0221,"HRK":7.5416,"HUF":310.99,"IDR":15641.0,"ILS":4.0634,"INR":75.147,"JPY":132.03,"KRW":1285.2,"MXN":22.071,"MYR":4.8828,"NOK":9.4543,"NZD":1.6717,"PHP":59.426,"PLN":4.2396,"RON":4.5945,"RUB":68.044,"SEK":9.7443,"SGD":1.5772,"THB":38.305,"TRY":4.4673,"USD":1.1562,"ZAR":16.386}}
  for (let currency in result.rates) {
    rates[currency] = Big(result.rates[currency])
  }
  return rates
}

async function _getRatesFromCoinMarketCap () {
  const rates = {}
  //const results = (await request.get(COINMARKETCAP_API)).body
  const results = JSON.parse(`[
    {
        "id": "bitcoin",
        "name": "Bitcoin",
        "symbol": "BTC",
        "rank": "1",
        "price_usd": "7274.01",
        "price_btc": "1.0",
        "24h_volume_usd": "2368700000.0",
        "market_cap_usd": "121253287732",
        "available_supply": "16669387.0",
        "total_supply": "16669387.0",
        "max_supply": "21000000.0",
        "percent_change_1h": "2.07",
        "percent_change_24h": "2.38",
        "percent_change_7d": "13.42",
        "last_updated": "1510104551",
        "price_eur": "6274.16822946",
        "24h_volume_eur": "2043112710.2",
        "market_cap_eur": "104586538320"
    },
    {
        "id": "ethereum",
        "name": "Ethereum",
        "symbol": "ETH",
        "rank": "2",
        "price_usd": "296.212",
        "price_btc": "0.0407832",
        "24h_volume_usd": "537752000.0",
        "market_cap_usd": "28314562835.0",
        "available_supply": "95588845.0",
        "total_supply": "95588845.0",
        "max_supply": null,
        "percent_change_1h": "0.75",
        "percent_change_24h": "-1.45",
        "percent_change_7d": "-3.04",
        "last_updated": "1510104561",
        "price_eur": "255.496475752",
        "24h_volume_eur": "463835836.592",
        "market_cap_eur": "24422612915.0"
    },
    {
        "id": "bitcoin-cash",
        "name": "Bitcoin Cash",
        "symbol": "BCH",
        "rank": "3",
        "price_usd": "623.351",
        "price_btc": "0.0858243",
        "24h_volume_usd": "363171000.0",
        "market_cap_usd": "10453580686.0",
        "available_supply": "16769975.0",
        "total_supply": "16769975.0",
        "max_supply": "21000000.0",
        "percent_change_1h": "1.23",
        "percent_change_24h": "2.15",
        "percent_change_7d": "39.67",
        "last_updated": "1510104560",
        "price_eur": "537.668911646",
        "24h_volume_eur": "313251693.366",
        "market_cap_eur": "9016694207.0"
    },
    {
        "id": "ripple",
        "name": "Ripple",
        "symbol": "XRP",
        "rank": "4",
        "price_usd": "0.209457",
        "price_btc": "0.00002884",
        "24h_volume_usd": "116295000.0",
        "market_cap_usd": "8070700548.0",
        "available_supply": "38531538922.0",
        "total_supply": "99993667738.0",
        "max_supply": "100000000000",
        "percent_change_1h": "0.05",
        "percent_change_24h": "2.14",
        "percent_change_7d": "4.42",
        "last_updated": "1510104541",
        "price_eur": "0.1806662975",
        "24h_volume_eur": "100309787.07",
        "market_cap_eur": "6961350475.0"
    },
    {
        "id": "litecoin",
        "name": "Litecoin",
        "symbol": "LTC",
        "rank": "5",
        "price_usd": "62.0886",
        "price_btc": "0.00854849",
        "24h_volume_usd": "434683000.0",
        "market_cap_usd": "3335738433.0",
        "available_supply": "53725457.0",
        "total_supply": "53725457.0",
        "max_supply": "84000000.0",
        "percent_change_1h": "1.68",
        "percent_change_24h": "11.9",
        "percent_change_7d": "11.49",
        "last_updated": "1510104541",
        "price_eur": "53.5542735756",
        "24h_volume_eur": "374934082.918",
        "market_cap_eur": "2877227842.0"
    },
    {
        "id": "dash",
        "name": "Dash",
        "symbol": "DASH",
        "rank": "6",
        "price_usd": "292.501",
        "price_btc": "0.0402722",
        "24h_volume_usd": "87523700.0",
        "market_cap_usd": "2244984953.0",
        "available_supply": "7675136.0",
        "total_supply": "7675136.0",
        "max_supply": "18900000.0",
        "percent_change_1h": "0.14",
        "percent_change_24h": "2.64",
        "percent_change_7d": "4.77",
        "last_updated": "1510104542",
        "price_eur": "252.295567546",
        "24h_volume_eur": "75493217.3402",
        "market_cap_eur": "1936402791.0"
    },
    {
        "id": "neo",
        "name": "NEO",
        "symbol": "NEO",
        "rank": "7",
        "price_usd": "26.236",
        "price_btc": "0.00361223",
        "24h_volume_usd": "32379500.0",
        "market_cap_usd": "1705340000.0",
        "available_supply": "65000000.0",
        "total_supply": "100000000.0",
        "max_supply": null,
        "percent_change_1h": "0.4",
        "percent_change_24h": "0.38",
        "percent_change_7d": "-7.52",
        "last_updated": "1510104551",
        "price_eur": "22.629756856",
        "24h_volume_eur": "27928808.207",
        "market_cap_eur": "1470934196.0"
    },
    {
        "id": "nem",
        "name": "NEM",
        "symbol": "XEM",
        "rank": "8",
        "price_usd": "0.183341",
        "price_btc": "0.00002524",
        "24h_volume_usd": "4883320.0",
        "market_cap_usd": "1650069000.0",
        "available_supply": "8999999999.0",
        "total_supply": "8999999999.0",
        "max_supply": null,
        "percent_change_1h": "2.23",
        "percent_change_24h": "-1.05",
        "percent_change_7d": "-1.78",
        "last_updated": "1510104546",
        "price_eur": "0.1581400462",
        "24h_volume_eur": "4212088.13272",
        "market_cap_eur": "1423260416.0"
    },
    {
        "id": "monero",
        "name": "Monero",
        "symbol": "XMR",
        "rank": "9",
        "price_usd": "99.8927",
        "price_btc": "0.0137535",
        "24h_volume_usd": "68127000.0",
        "market_cap_usd": "1530672708.0",
        "available_supply": "15323169.0",
        "total_supply": "15323169.0",
        "max_supply": null,
        "percent_change_1h": "-0.3",
        "percent_change_24h": "-2.33",
        "percent_change_7d": "13.95",
        "last_updated": "1510104543",
        "price_eur": "86.1620488142",
        "24h_volume_eur": "58762671.342",
        "market_cap_eur": "1320275621.0"
    },
    {
        "id": "ethereum-classic",
        "name": "Ethereum Classic",
        "symbol": "ETC",
        "rank": "10",
        "price_usd": "14.2939",
        "price_btc": "0.00196801",
        "24h_volume_usd": "180445000.0",
        "market_cap_usd": "1389752887.0",
        "available_supply": "97226991.0",
        "total_supply": "97226991.0",
        "max_supply": null,
        "percent_change_1h": "0.57",
        "percent_change_24h": "-1.99",
        "percent_change_7d": "34.67",
        "last_updated": "1510104552",
        "price_eur": "12.3291462694",
        "24h_volume_eur": "155642112.97",
        "market_cap_eur": "1198725793.0"
    },
    {
        "id": "iota",
        "name": "IOTA",
        "symbol": "MIOTA",
        "rank": "11",
        "price_usd": "0.385497",
        "price_btc": "0.00005308",
        "24h_volume_usd": "15727000.0",
        "market_cap_usd": "1071500586.0",
        "available_supply": "2779530283.0",
        "total_supply": "2779530283.0",
        "max_supply": "2779530283.0",
        "percent_change_1h": "0.75",
        "percent_change_24h": "3.96",
        "percent_change_7d": "-0.66",
        "last_updated": "1510104559",
        "price_eur": "0.3325088954",
        "24h_volume_eur": "13565260.942",
        "market_cap_eur": "924218544.0"
    },
    {
        "id": "qtum",
        "name": "Qtum",
        "symbol": "QTUM",
        "rank": "12",
        "price_usd": "11.0653",
        "price_btc": "0.0015235",
        "24h_volume_usd": "122288000.0",
        "market_cap_usd": "814903355.0",
        "available_supply": "73644940.0",
        "total_supply": "100144940.0",
        "max_supply": null,
        "percent_change_1h": "-0.43",
        "percent_change_24h": "5.0",
        "percent_change_7d": "6.34",
        "last_updated": "1510104557",
        "price_eur": "9.5443302538",
        "24h_volume_eur": "105479025.248",
        "market_cap_eur": "702891629.0"
    },
    {
        "id": "omisego",
        "name": "OmiseGO",
        "symbol": "OMG",
        "rank": "13",
        "price_usd": "6.3876",
        "price_btc": "0.00087946",
        "24h_volume_usd": "16992900.0",
        "market_cap_usd": "651807004.0",
        "available_supply": "102042552.0",
        "total_supply": "140245398.0",
        "max_supply": null,
        "percent_change_1h": "0.75",
        "percent_change_24h": "-1.96",
        "percent_change_7d": "-6.76",
        "last_updated": "1510104560",
        "price_eur": "5.5095988296",
        "24h_volume_eur": "14657157.9234",
        "market_cap_eur": "562213524.0"
    },
    {
        "id": "zcash",
        "name": "Zcash",
        "symbol": "ZEC",
        "rank": "14",
        "price_usd": "241.67",
        "price_btc": "0.0332736",
        "24h_volume_usd": "56332900.0",
        "market_cap_usd": "621458936.0",
        "available_supply": "2571519.0",
        "total_supply": "2571519.0",
        "max_supply": null,
        "percent_change_1h": "0.74",
        "percent_change_24h": "5.05",
        "percent_change_7d": "4.45",
        "last_updated": "1510104558",
        "price_eur": "208.45149182",
        "24h_volume_eur": "48589717.5634",
        "market_cap_eur": "536036920.0"
    },
    {
        "id": "lisk",
        "name": "Lisk",
        "symbol": "LSK",
        "rank": "15",
        "price_usd": "5.20527",
        "price_btc": "0.00071667",
        "24h_volume_usd": "12724900.0",
        "market_cap_usd": "596424469.0",
        "available_supply": "114580890.0",
        "total_supply": "114580890.0",
        "max_supply": null,
        "percent_change_1h": "0.95",
        "percent_change_24h": "12.23",
        "percent_change_7d": "10.16",
        "last_updated": "1510104550",
        "price_eur": "4.4897848174",
        "24h_volume_eur": "10975811.5954",
        "market_cap_eur": "514443540.0"
    },
    {
        "id": "bitconnect",
        "name": "BitConnect",
        "symbol": "BCC",
        "rank": "16",
        "price_usd": "275.978",
        "price_btc": "0.0379972",
        "24h_volume_usd": "22816400.0",
        "market_cap_usd": "590066354.0",
        "available_supply": "2138092.0",
        "total_supply": "8392580.0",
        "max_supply": "28000000.0",
        "percent_change_1h": "2.42",
        "percent_change_24h": "3.94",
        "percent_change_7d": "16.25",
        "last_updated": "1510104554",
        "price_eur": "238.043719988",
        "24h_volume_eur": "19680194.5544",
        "market_cap_eur": "508959373.0"
    },
    {
        "id": "cardano",
        "name": "Cardano",
        "symbol": "ADA",
        "rank": "17",
        "price_usd": "0.0222915",
        "price_btc": "0.00000307",
        "24h_volume_usd": "2500830.0",
        "market_cap_usd": "577953293.0",
        "available_supply": "25927070538.0",
        "total_supply": "31112483745.0",
        "max_supply": "45000000000.0",
        "percent_change_1h": "2.19",
        "percent_change_24h": "1.87",
        "percent_change_7d": "-22.0",
        "last_updated": "1510104564",
        "price_eur": "0.0192274442",
        "24h_volume_eur": "2157080.91318",
        "market_cap_eur": "498511301.0"
    },
    {
        "id": "tether",
        "name": "Tether",
        "symbol": "USDT",
        "rank": "18",
        "price_usd": "1.00446",
        "price_btc": "0.0001383",
        "24h_volume_usd": "254986000.0",
        "market_cap_usd": "516354382.0",
        "available_supply": "514061667.0",
        "total_supply": "514999472.0",
        "max_supply": null,
        "percent_change_1h": "0.18",
        "percent_change_24h": "0.35",
        "percent_change_7d": "0.5",
        "last_updated": "1510104546",
        "price_eur": "0.8663929552",
        "24h_volume_eur": "219937154.356",
        "market_cap_eur": "445379407.0"
    },
    {
        "id": "stellar",
        "name": "Stellar Lumens",
        "symbol": "XLM",
        "rank": "19",
        "price_usd": "0.030972",
        "price_btc": "0.00000426",
        "24h_volume_usd": "29220100.0",
        "market_cap_usd": "513774053.0",
        "available_supply": "16588339568.0",
        "total_supply": "103412659883",
        "max_supply": null,
        "percent_change_1h": "0.73",
        "percent_change_24h": "2.54",
        "percent_change_7d": "5.04",
        "last_updated": "1510104557",
        "price_eur": "0.0267147747",
        "24h_volume_eur": "25203680.3746",
        "market_cap_eur": "443153754.0"
    },
    {
        "id": "eos",
        "name": "EOS",
        "symbol": "EOS",
        "rank": "20",
        "price_usd": "0.967737",
        "price_btc": "0.00013324",
        "24h_volume_usd": "16021000.0",
        "market_cap_usd": "443938794.0",
        "available_supply": "458739094.0",
        "total_supply": "1000000000.0",
        "max_supply": null,
        "percent_change_1h": "1.79",
        "percent_change_24h": "0.79",
        "percent_change_7d": "26.46",
        "last_updated": "1510104559",
        "price_eur": "0.8347176784",
        "24h_volume_eur": "13818849.466",
        "market_cap_eur": "382917631.0"
    },
    {
        "id": "hshare",
        "name": "Hshare",
        "symbol": "HSR",
        "rank": "21",
        "price_usd": "9.72861",
        "price_btc": "0.00133946",
        "24h_volume_usd": "12840500.0",
        "market_cap_usd": "410764998.0",
        "available_supply": "42222373.0",
        "total_supply": "42222373.0",
        "max_supply": "84000000.0",
        "percent_change_1h": "1.09",
        "percent_change_24h": "2.15",
        "percent_change_7d": "-9.25",
        "last_updated": "1510104564",
        "price_eur": "8.3913736411",
        "24h_volume_eur": "11075521.913",
        "market_cap_eur": "354303706.0"
    },
    {
        "id": "waves",
        "name": "Waves",
        "symbol": "WAVES",
        "rank": "22",
        "price_usd": "3.73971",
        "price_btc": "0.00051489",
        "24h_volume_usd": "11373700.0",
        "market_cap_usd": "373971000.0",
        "available_supply": "100000000.0",
        "total_supply": "100000000.0",
        "max_supply": null,
        "percent_change_1h": "1.67",
        "percent_change_24h": "5.35",
        "percent_change_7d": "18.18",
        "last_updated": "1510104551",
        "price_eur": "3.2256719017",
        "24h_volume_eur": "9810339.4402",
        "market_cap_eur": "322567190.0"
    },
    {
        "id": "stratis",
        "name": "Stratis",
        "symbol": "STRAT",
        "rank": "23",
        "price_usd": "3.0579",
        "price_btc": "0.00042102",
        "24h_volume_usd": "4853140.0",
        "market_cap_usd": "301549284.0",
        "available_supply": "98613193.0",
        "total_supply": "98613193.0",
        "max_supply": null,
        "percent_change_1h": "1.88",
        "percent_change_24h": "1.52",
        "percent_change_7d": "-8.32",
        "last_updated": "1510104551",
        "price_eur": "2.6375794134",
        "24h_volume_eur": "4186056.49444",
        "market_cap_eur": "260100128.0"
    },
    {
        "id": "komodo",
        "name": "Komodo",
        "symbol": "KMD",
        "rank": "24",
        "price_usd": "2.72952",
        "price_btc": "0.00037581",
        "24h_volume_usd": "5671350.0",
        "market_cap_usd": "275532788.0",
        "available_supply": "100945510.0",
        "total_supply": "100945510.0",
        "max_supply": null,
        "percent_change_1h": "-0.19",
        "percent_change_24h": "2.22",
        "percent_change_7d": "21.98",
        "last_updated": "1510104554",
        "price_eur": "2.3543365579",
        "24h_volume_eur": "4891800.2571",
        "market_cap_eur": "237659705.0"
    },
    {
        "id": "ark",
        "name": "Ark",
        "symbol": "ARK",
        "rank": "25",
        "price_usd": "2.61305",
        "price_btc": "0.00035977",
        "24h_volume_usd": "3861750.0",
        "market_cap_usd": "256029994.0",
        "available_supply": "97981284.0",
        "total_supply": "129231284.0",
        "max_supply": null,
        "percent_change_1h": "2.19",
        "percent_change_24h": "0.41",
        "percent_change_7d": "9.58",
        "last_updated": "1510104556",
        "price_eur": "2.2538758253",
        "24h_volume_eur": "3330937.0155",
        "market_cap_eur": "220837647.0"
    }
]`)
  for (let result of results) {
    rates[result.symbol] = Big(result.price_eur)
  }
  return rates
}

exports.createConnector = createConnector
