'use strict'

const Debug = require('debug')
const RippleAPI = require('ripple-lib').RippleAPI
const rippleKeypairs = require('ripple-keypairs')
const Big = require('big.js')
const crypto = require('crypto')
// TODO switch to levelup + jsondown when https://github.com/toolness/jsondown/pull/5 is merged
const lowdb = require('lowdb')
const FileAsync = require('lowdb/adapters/FileAsync')
const { fork } = require('child_process')
const fs = require('fs')
const httpClient = require('./http').client

// TODO if there are multiple xrp addresses in the ILP address, which one should we assume we're sending to? first or last?
const XRP_ILP_ADDRESS = /^(3|test[^.]*|example)\.crypto\.xrp\..*(r[A-HJ-NP-Za-km-z1-9]{24,34}).*$/
const XRP_CLAIM = /^(?:([a-f0-9]{64}) )?(\d+) ([a-f0-9]+)$/i
const XRP_CURRENCY_SCALE = 6
const KEYPAIR_GENERATION_STRING = 'ilp3-xrp-paychan'
const DROPS_PER_XRP = 1000000
const NULL_FULFILLMENT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const NULL_FULFILLMENT_CONDITION = 'Zmh6rfhivXdsj8GLjp+OIAiXFIVu4jOzkCpZHQ1fKSU='
const DEFAULT_CHANNEL_SIZE = 100 * DROPS_PER_XRP
const DEFAULT_SETTLE_DELAY = 86400 // 1 day
const STARTING_MIN_BALANCE = '-1000'
const CHANNEL_WATCHER_INTERVAL = 3600000
const DEFAULT_CLAIM_AMOUNT = 100000000
const DEFAULT_CHANNEL_PRICE = 5 * DROPS_PER_XRP + 20 // account reserve + 2 tx fees

function incoming ({ address, secret, server, channelDbPath = 'xrp-incoming.json', claimAmount = DEFAULT_CLAIM_AMOUNT }) {
  const debug = Debug('ilp3-xrp:incoming')
  const api = new RippleAPI({ server })
  let db
  let channels = {}

  debug('spawning child process to watch for when payment channel claims need to be submitted')
  spawnChannelWatcher({ address, secret, server, channelDbPath, claimAmount })

  return async function (ctx, next) {
    const transfer = ctx.incoming.transfer
    const claim = transfer && transfer.extensions && transfer.extensions.xrp_claim
    if (!claim) {
      return next()
    }

    if (!db) {
      db = await lowdb(new FileAsync(channelDbPath))
      await db.defaults({ incoming_channels: {} }).write()
    }

    // TODO don't connect in the transaction flow
    if (!api.isConnected()) {
      await connectToRippled({ api, address })
      debug('connected to rippled server')
    }

    const details = XRP_CLAIM.exec(claim)
    if (!details) {
      const err = new Error('invalid claim')
      err.code = 'F01'
      err.triggeredAt = new Date().toISOString()
      throw err
    }
    const channelId = details[1]
    const drops = details[2]
    const signature = details[3]

    // TODO handle if the peer starts closing the channel after we've looked it up
    let channel = channels[channelId] || await db.get('incoming_channels')
      .get(channelId)
      .value()
    if (!channel) {
      debug(`no record of channel ${channelId} in db, querying rippled`)
      const paychan = await api.getPaymentChannel(channelId)
      if (!paychan
          || paychan.destination !== address
          || paychan.settleDelay < DEFAULT_SETTLE_DELAY
          || paychan.cancelAfter
          || paychan.expiration) {
          const err = new Error('unacceptable payment channel')
          err.status = 422
          err.code = 'F01'
          err.triggeredAt = new Date().toISOString()
          throw err
      }
      channel = {
        amount: Big(0),
        maxAmount: xrpToDrops(paychan.amount),
        publicKey: paychan.publicKey,
        signature: null,
        fromAccount: paychan.account
      }
      channels[channelId] = channel
    }

    // Verify claim
    // (Note that zero-value claims are used to verify the user on the first payment)
    const valid = api.verifyPaymentChannelClaim(channelId, dropsToXrp(drops), signature, channel.publicKey)
    const claimValue = Big(drops).minus(channel.amount)
    if (!valid || claimValue.lt(0) || Big(drops).gt(channel.maxAmount)) {
      debug(`got invalid payment channel claim on channel: ${channelId}`)
      const err = new Error('invalid payment channel claim')
      err.status = 422
      err.code = 'F01'
      err.triggeredAt = new Date().toISOString()
      throw err
    }

    channel.signature = signature
    channel.amount = Big(drops)
    debug(`got claim from peer ${channel.fromAccount} for ${claimValue} drops on channel ${channelId} (total channel claim amount: ${channel.amount})`)

    // TODO is this dangerous? should this just come from the auth middleware instead?
    if (!transfer.from) {
      // TODO find a better way of determining whether it's on the livenet
      const isTestnet = /rippletest\.net/.test(server)
      transfer.from = `${(isTestnet ? 'test' : '')}3.crypto.xrp.pc.${address}.${channel.fromAccount}`
      debug(`set transfer.from to: ${transfer.from}`)
    }

    ctx.incoming.account.currencyScale = XRP_CURRENCY_SCALE
    ctx.incoming.account.currencyCode = 'XRP'

    // TODO minimum balance should adjust the longer a user uses this connector
    if (!ctx.incoming.account.minBalance && ctx.incoming.account.minBalance !== 0) {
      ctx.incoming.account.minBalance = STARTING_MIN_BALANCE
    }

    // Pass this adjustment to the balance tracker
    ctx.incoming.account.adjustBalance = claimValue.toString()

    await Promise.all([
      next(),
      db.get('incoming_channels')
        .set(channelId, channel)
        .write()
    ])
  }
}

function outgoing ({ address, secret, server, paychanSize = DEFAULT_CHANNEL_SIZE, channelDbPath = 'xrp-outgoing.json', sendClaimImmediately }) {
  const debug = Debug('ilp3-xrp:outgoing')
  const api = new RippleAPI({ server })
  let db
  const keypairs = {}
  const channels = {}

  return async function (ctx, next) {
    const transfer = ctx.outgoing.transfer
    if (!transfer.to) {
      return next()
    }
    const match = XRP_ILP_ADDRESS.exec(transfer.to)
    if (!match) {
      return next()
    }
    // TODO peer address should be whatever comes after the connector's address
    const peerAddress = match[2]

    // TODO don't connect in the transaction flow
    if (!api.isConnected()) {
      await connectToRippled({ api, address })
      debug('connected to rippled server')
    }

    if (!db) {
      db = await lowdb(new FileAsync(channelDbPath))
      await db.defaults({ outgoing_channels: {} }).write()
    }

    let keypair = keypairs[peerAddress]
    if (!keypair) {
      keypair = keypairs[peerAddress] = generateChannelKeypair({ secret, peerAddress })
    }

    let channel = channels[peerAddress] || await db.get('outgoing_channels')
      .get(peerAddress)
      .value()
    if (!channel) {
      const id = await createChannel({
        api,
        address,
        secret,
        peerAddress,
        publicKey: keypair.publicKey
      })
      const claim = Buffer.alloc(44, 0)
      claim.write('CLM\0')
      Buffer.from(id, 'hex').copy(claim, 4)

      channel = {
        id,
        amount: Big(0)
      }

      channels[peerAddress] = channel
      await db.get('outgoing_channels')
        .set(peerAddress, channel)
        .write()
    }

    if (sendClaimImmediately) {
      channel.amount = Big(channel.amount).plus(transfer.amount)
      debug(`increasing channel amount to ${channel.amount}`)
    }

    // Send the claim for the previously fulfilled transfers, unless sendClaimImmediately is true
    // (on the first transfer it's normally zero, and that just goes to prove that
    // we actually have the private key corresponding to the channel's public key)
    if (!transfer.extensions) {
      transfer.extensions = {}
    }
    const signature = api.signPaymentChannelClaim(channel.id, dropsToXrp(channel.amount), keypair.privateKey)
    transfer.extensions.xrp_claim = `${channel.id} ${channel.amount} ${signature}`

    await next()

    if (!sendClaimImmediately) {
      // Increase the claim amount if the transfer succeeds
      channel.amount = Big(channel.amount).plus(transfer.amount)
      debug(`transfer succeeded, increasing channel amount to ${channel.amount}`)
    }

    await db.get('outgoing_channels')
      .set(peerAddress, channel)
      .write()
  }
}

function handleChannelRequest (opts) {
  const debug = Debug('ilp3-xrp:handleChannelRequest')
  if (!opts) {
    opts = {}
  }

  const channelPrice = (typeof opts.price === 'string' || typeof opts.price === 'number' ? Big(opts.price) : Big(DEFAULT_CHANNEL_PRICE))

  return async function (ctx, next) {
    const transfer = ctx.incoming.transfer
    if (!transfer.extensions || !transfer.extensions.xrp_channel_request) {
      return next()
    }

    if (transfer.condition !== NULL_FULFILLMENT_CONDITION) {
      const err = new Error('condition must be ' + NULL_FULFILLMENT_CONDITION)
      err.status = 422
      err.code = 'F05'
      throw err
    }

    if (Big(ctx.incoming.account.adjustBalance).lt(channelPrice)) {
      const err = new Error('claim amount is less than the channel price: ' + channelPrice.toString())
      err.status = 422
      err.code = 'F01'
      throw err
    }

    debug(`handling request to create channel to ${transfer.from} (peer paid: ${ctx.incoming.account.adjustBalance} drops)`)
    try {
      await Promise.resolve()
        .then(opts.handler({
          address: transfer.from,
          uri: transfer.extensions.xrp_channel_request,
          currencyCode: 'XRP',
          currencyScale: 6
        }))
    } catch (err) {
      debug('error in channel request handler:', err)
      throw err
    }

    ctx.fulfillment = NULL_FULFILLMENT
    return
  }
}

// TODO make this function async so the user can properly handle errors
function requestChannel (opts) {
  const debug = Debug('ilp3-xrp:requestChannel')
  if (!opts) {
    opts = {}
  }

  const address = opts.address
  const secret = opts.secret
  const server = opts.server
  const channelDbPath = opts.channelDbPath || 'xrp-outgoing-request.json'

  // TODO don't request the channel again if it already exists

  async function requestChannelIfNoneExists () {
    const db = await lowdb(new FileAsync(channelDbPath))
    await db.defaults({ outgoing_channels: {} }).write()
    const channel = await db.get('outgoing_channels')
      .get(opts.peerAddress)
      .value()
    if (channel) {
      debug('channel already exists, no need to request a new channel')
      return
    }

    // Create an outgoing channel to request that the peer create a channel to us
    // (this uses the xrp.outgoing and http.client middleware)
    const out = outgoing(Object.assign({
      sendClaimImmediately: true,
      channelDbPath,
      paychanSize: DEFAULT_CHANNEL_PRICE
    }, opts))
    const isTestnet = /rippletest\.net/.test(server)
    const ilpAddress =  `${(isTestnet ? 'test' : '')}3.crypto.xrp.pc.${opts.peerAddress}`
    const ctx = {
      outgoing: {
        transfer: {
          amount: DEFAULT_CHANNEL_PRICE,
          to: ilpAddress,
          destination: ilpAddress,
          expiry: new Date(Date.now() + 10000).toISOString(),
          condition: NULL_FULFILLMENT_CONDITION,
          data: Buffer.from([]),
          extensions: {
            xrp_channel_request: opts.uri
          }
        },
        account: {
          uri: opts.peerUri
        }
      }
    }
    debug('sending transfer on outgoing channel to request incoming channel')
    await out(ctx, httpClient().bind(null, ctx, () => Promise.resolve()))
    if (ctx.fulfillment === NULL_FULFILLMENT) {
      debug(`channel request acknowledged by peer: ${opts.peerAddress}`)
    }
  }

  requestChannelIfNoneExists()
    .catch((err) => {
      console.error('error requesting incoming xrp payment channel', err)
      throw err
    })

  // TODO should we return this middleware here or let the user add that separately
  return incoming(Object.assign({}, opts, {
    channelDbPath
  }))
}

async function connectToRippled ({ api, address }) {
  await api.connect()
  // TODO do we need to listen to the peer address too?
  await api.connection.request({
    command: 'subscribe',
    accounts: [ address ]
  })
}

async function createChannel({ api, address, secret, peerAddress, publicKey }) {
  const debug = Debug('ilp3-xrp:createChannel')
  try {
    debug(`creating channel from ${address} to ${peerAddress}`)
    const sourceTagBuffer = crypto.randomBytes(32)
    const sourceTag = sourceTagBuffer.readUInt32BE(0)
    const tx = await api.preparePaymentChannelCreate(address, {
      amount: dropsToXrp(DEFAULT_CHANNEL_SIZE),
      destination: peerAddress,
      settleDelay: DEFAULT_SETTLE_DELAY,
      publicKey,
      sourceTag
    })
    const signed = api.sign(tx.txJSON, secret)
    // TODO what if the payment channel creation fails
    const channelCreatedPromise = new Promise((resolve, reject) => {
      function listenForValidatedTx (ev) {
        if (!ev.validated || ev.transaction.SourceTag !== sourceTag || ev.transaction.Account !== address) {
          return
        }
        for (let node of ev.meta.AffectedNodes) {
          if (node.CreatedNode && node.CreatedNode.LedgerEntryType === 'PayChannel') {
            resolve(node.CreatedNode.LedgerIndex)
          }
        }
        api.connection.removeListener('transaction', listenForValidatedTx)
      }
      api.connection.on('transaction', listenForValidatedTx)
    })
    const result = await api.submit(signed.signedTransaction)
    if (result.resultCode !== 'tesSUCCESS') {
      throw new Error(`${result.resultCode}: ${result.resultMessage}`)
    }
    const channelId = await channelCreatedPromise
    debug(`created channel from ${address} to ${peerAddress}, id: ${channelId}`)
    return channelId
  } catch (err) {
    debug(`error creating channel with peer ${peerAddress}:`, err)
    throw err
  }
}

function generateChannelKeypair ({ secret, peerAddress }) {
  const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'))
  hmac.update(`${KEYPAIR_GENERATION_STRING}:${peerAddress}`)
  const entropy = hmac.digest()
  const seed = rippleKeypairs.generateSeed({ entropy })
  return rippleKeypairs.deriveKeypair(seed)
}

function writeUInt64 (buffer, val, offset) {
  const big = Big(val)
  const high = big.div(0x100000000).round(0)
  const low = big.mod(0x100000000).round(0)
  buffer.writeUInt32BE(parseInt(high), offset)
  buffer.writeUInt32BE(parseInt(low), offset + 4)
  return buffer
}

const dropsToXrp = (drops) => Big(drops).div(DROPS_PER_XRP).toString()
const xrpToDrops = (xrp) => Big(xrp).mul(DROPS_PER_XRP).toString()

// Spawn separate process to watch for when we need to submit claims on the channel
function spawnChannelWatcher ({ address, secret, server, channelDbPath, claimAmount }) {
  const out = fs.openSync('./xrp-channel-watcher.log', 'a')
  return fork(__filename, {
    env: {
      __XRP_CHANNEL_WATCHER__: true,
      address,
      secret,
      server,
      channelDbPath,
      claimAmount
    },
    detached: true,

    stdio: ['ignore', out, out, 'ipc']
  })
}

async function watchChannels ({ address, secret, server, channelDbPath, claimAmount }) {
  const db = await lowdb(new FileAsync(channelDbPath))
  await db.defaults({ incoming_channels: {} }).write()

  const api = new RippleAPI({ server })
  await api.connect()
  console.log('connected to rippled server')

  setInterval(() => checkIfChannelsNeedToBeClaimed({
    address,
    secret,
    db,
    api,
    claimAmount
  }), CHANNEL_WATCHER_INTERVAL)

  // When the parent process exits, submit the claims and exit also
  process.once('disconnect', async () => {
    console.log('parent process disconnected, submitting claims')
    await checkIfChannelsNeedToBeClaimed({
      address,
      secret,
      db,
      api,
      claimAmount,
      forceClaim: true
    })
    process.exit(0)
  })
}

async function checkIfChannelsNeedToBeClaimed ({ address, secret, api, db, claimAmount, forceClaim }) {
  const channels = await db.get('incoming_channels')
    .toPairs()
    .value()
  for (let [id, channel] of channels) {
    const paychan = await api.getPaymentChannel(id)
    const amountToClaim = Big(channel.amount)
      .minus(xrpToDrops(paychan.balance))

    // We assume the channel will only have an expiration if the sender initiated the close tx
    if (forceClaim || paychan.expiration || amountToClaim.lte(claimAmount)) {
      console.log(`submitting claim for channel ${id} for balance: ${channel.amount} (address: ${address})`)
      const tx = await api.preparePaymentChannelClaim(address, {
        channel: id,
        balance: dropsToXrp(channel.amount),
        signature: channel.signature,
        publicKey: channel.publicKey
      })
      const signed = api.sign(tx.txJSON, secret)
      const result = await api.submit(signed.signedTransaction)
      console.log(`got result from submitting claim for channel ${id}:`, result, `(address: ${address})`)

      // TODO watch for validated tx to confirm that it made it into ledger
    }
  }
}

if (!module.parent && process.env.__XRP_CHANNEL_WATCHER__) {
  watchChannels(process.env)
}

exports.incoming = incoming
exports.outgoing = outgoing
exports.requestChannel = requestChannel
exports.handleChannelRequest = handleChannelRequest
