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
    return compose(this.stack)
  }

  // Function to call the middleware without an incoming HTTP request
  send (ctx, next) {
    async function returnCtx (ctx, next) {
      await next()
      return ctx
    }
    const fn = compose([returnCtx].concat(this.stack))
    return fn(Object.assign({
      app: this,
      state: {},
      respond: false
    }, ctx), next)
  }
}

module.exports = ILP3
