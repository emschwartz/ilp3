'use strict'

const encoding = require('encoding-down')

function sublevel (down, prefix, separator = ' ') {
  prefix = prefix + separator
  const prefixBuf = Buffer.from(prefix)

  class Sublevel extends encoding {
    constructor (db, opts) {
      super(db, opts)
    }

    // Don't open the underlying db multiple times
    _open (opts, cb) {
      let db = this.db
      while (db.db) {
        db = db.db
      }
      if (db.status === 'new') {
        return this.db.open(opts, cb)
      } else if (typeof cb === 'function') {
        return cb()
      }
    }
  }

  const sub = new Sublevel(down, {
    keyEncoding: {
      type: 'sublevel',
      buffer: false,
      encode: (key) => {
        if (Buffer.isBuffer(key)) {
          return Buffer.concat([prefixBuf, Buffer.from(key)])
        } else {
          return prefix + key
        }
      },
      decode: (key) => {
        if (Buffer.isBuffer(key)) {
          return key.slice(prefixBuf.length)
        } else {
          return key.slice(prefix.length)
        }
      }
    }
  })
  return sub
}

module.exports = sublevel
