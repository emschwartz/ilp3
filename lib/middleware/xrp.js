'use strict'

const Debug = require('debug')
const RippleAPI = require('ripple-lib').RippleAPI
const rippleKeypairs = require('ripple-keypairs')
const Big = require('big.js')
const crypto = require('crypto')

const XRP_ILP_ADDRESS = /^(3|test[^.]*|example)\.crypto\.xrp\..*(r[A-HJ-NP-Za-km-z1-9]{24,34}).*$/
const XRP_CLAIM = /^(?:([a-f0-9]{64}) )?(\d+) ([a-f0-9]+)$/i
const XRP_CURRENCY_SCALE = 6
const KEYPAIR_GENERATION_STRING = 'ilp3-xrp-paychan'
const DROPS_PER_XRP = 1000000
const NULL_CONDITION = Buffer.alloc(32, 0)
const DEFAULT_CHANNEL_SIZE = 100 * DROPS_PER_XRP
const DEFAULT_SETTLE_DELAY = 86400 // 1 day

function incoming ({ address, secret, server }) {
  const debug = Debug('ilp3-xrp:incoming')
  const channels = {}
  const api = new RippleAPI({ server })

  return async function (ctx, next) {
    const claim = ctx.transfer && ctx.transfer.extensions && ctx.transfer.extensions.xrp_claim
    if (!claim) {
      return next()
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

    let channel = channels[channelId]
    if (!channel) {
      const paychan = await api.getPaymentChannel(channelId)
      if (!paychan
        || paychan.destination !== address
        || paychan.settleDelay < DEFAULT_SETTLE_DELAY
        || paychan.cancelAfter) {
          const err = new Error('unacceptable payment channel')
          err.status = 422
          err.code = 'F01'
          err.triggeredAt = new Date().toISOString()
          throw err
      }
      // TODO this really needs to come from the db so we don't double-credit a claim
      channel = {
        amount: Big(0),
        maxAmount: paychan.amount,
        publicKey: paychan.publicKey,
        signature: null,
        fromAccount: paychan.account
      }
      channels[channelId] = channel
    }

    // Verify claim
    const valid = api.verifyPaymentChannelClaim(channelId, dropsToXrp(drops), signature, channel.publicKey)
    const claimValue = Big(drops).minus(channel.amount)
    if (!valid || claimValue.lte(0)) {
      debug(`got invalid payment channel claim on channel: ${channelId}`)
      const err = new Error('invalid payment channel claim')
      err.status = 422
      err.code = 'F01'
      err.triggeredAt = new Date().toISOString()
      throw err
    }

    channel.signature = signature
    channel.amount = Big(drops)
    debug(`got claim from peer for ${claimValue} drops on channel ${channelId} (total channel claim amount: ${channel.amount})`)

    // TODO is this dangerous? should this just come from the auth middleware instead?
    if (!ctx.transfer.from) {
      // TODO find a better way of determining whether it's on the livenet
      const isTestnet = /rippletest\.net/.test(server)
      ctx.transfer.from = `${(isTestnet ? 'test' : '')}3.crypto.xrp.${channel.fromAccount}`
    }
    if (!ctx.account) {
      ctx.account = {}
    }
    ctx.account.currencyScale = XRP_CURRENCY_SCALE
    ctx.account.currencyCode = 'XRP'

    // Pass this adjustment to the balance tracker
    ctx.adjustBalance = claimValue.toString()

    await next()

    // TODO deduct transfer amount from amount we owe if it fails
  }
}

function outgoing ({ address, secret, server, paychanSize = DEFAULT_CHANNEL_SIZE }) {
  const debug = Debug('ilp3-xrp:outgoing')
  const channels = {}
  const api = new RippleAPI({ server })

  return async function (ctx, next) {
    if (!ctx.transfer.to) {
      return next()
    }
    const match = XRP_ILP_ADDRESS.exec(ctx.transfer.to)
    if (!match) {
      return next()
    }
    const peerAddress = match[2]

    // TODO don't connect in the transaction flow
    if (!api.isConnected()) {
      await connectToRippled({ api, address })
      debug('connected to rippled server')
    }

    //// Don't add claims to unfulfillable payments
    //if (Buffer.from(ctx.transfer.condition, 'base64').equals(NULL_CONDITION)) {
      //return next()
    //}

    let channel = channels[ctx.transfer.to]
    if (!channel) {
      const keypair = generateChannelKeypair({ secret, peerAddress })
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

      channel = channels[ctx.transfer.to] = {
        keypair,
        id,
        amount: Big(0),
        claim
      }
    }

    // Sign a new claim and attach it to the transfer
    // TODO pay for previous transfers, not this one (put the risk on the connector)
    const claimDrops = ctx.transfer.amount
    channel.amount = channel.amount.plus(claimDrops)
    writeUInt64(channel.claim, channel.amount, 36)
    const signature = rippleKeypairs.sign(channel.claim.toString('hex'), channel.keypair.privateKey)

    if (!ctx.transfer.extensions) {
      ctx.transfer.extensions = {}
    }
    ctx.transfer.extensions.xrp_claim = `${channel.id} ${channel.amount} ${signature}`

    return next ()
  }
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

exports.incoming = incoming
exports.outgoing = outgoing
