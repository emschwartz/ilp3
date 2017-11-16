'use strict'

const compose = require('koa-compose')

class ILP3 {
  constructor (opts) {
    this.stack = []
  }

  use (middleware) {
    this.stack.push(middleware)
    return this
  }

  middleware () {
    return (ctx, next) => {
      if (!ctx.incoming) {
        ctx.incoming = {}
      }
      if (!ctx.incoming.account) {
        ctx.incoming.account = {}
      }
      if (!ctx.incoming.transfer) {
        ctx.incoming.transfer = null
      }
      if (!ctx.outgoing) {
        ctx.outgoing = {}
      }
      if (!ctx.outgoing.account) {
        ctx.outgoing.account = {}
      }
      if (!ctx.outgoing.transfer) {
        ctx.outgoing.transfer = null
      }

      return compose(this.stack)(ctx, next)
    }
  }

  // TODO should this also accept an account (source or destination)?
  async send (transfer, account) {
    const ctx = {
      outgoing: {
        transfer,
        account
      }
    }
    await this.middleware()(ctx)
    return ctx
  }

  async handleIncoming (transfer, account) {
    const ctx = {
      incoming: {
        transfer,
        account
      }
    }
    await this.middleware()(ctx)
    return ctx
  }
}

module.exports = ILP3
