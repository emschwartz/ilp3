'use strict'

// TODO make it a routing table so the connector it chooses depends on the prefix (if one is set)
const list = {
  xrpTestnet: [{
    uri: 'http://localhost:3000',
    account: 'test3.crypto.xrp.rw3PbBm3HJGXtJUxstWWDtu1i3U7ss9T2T'
  }]
}

function addConnector (network, ctx, next) {
  if (ctx.outgoing.transfer && !ctx.outgoing.transfer.to) {
    if (list[network] && list[network].length > 0) {
      // TODO choose a random one from the list
      ctx.outgoing.account.uri = list[network][0].uri
      ctx.outgoing.transfer.to = list[network][0].account
    }
  }
  return next()
}

function defaultConnector (network) {
  return addConnector.bind(null, network)
}

module.exports = defaultConnector
module.exports.xrpTestnet = () => defaultConnector('xrpTestnet')
