'use strict'

const Koa = require('koa')
const compose = require('koa-compose')

class ILP3 extends Koa {
  constructor () {
    super()
  }

  // Function to call the middleware without an incoming HTTP request
  send (ctx, next) {
    async function returnCtx (ctx, next) {
      await next()
      return ctx
    }
    const fn = compose([returnCtx].concat(this.middleware))
    return fn(Object.assign({
      app: this,
      state: {},
      respond: false
    }, ctx), next)
  }
}

module.exports = ILP3
