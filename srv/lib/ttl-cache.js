// Tiny in-memory cache with a TTL sweep on every write — same spirit as
// remote-connect.js's `connections` cache, but for short-lived state that
// bridges a two-step "AI proposal -> confirm" flow (fix suggestions, iflow
// design proposals). A server restart just means the user has to re-analyze,
// which is an acceptable cost for not needing a real datastore for this
// transient state.

function createTtlCache(ttlMs) {
  const store = new Map()

  function set(key, value) {
    const now = Date.now()
    for (const [k, v] of store) if (now - v.ts > ttlMs) store.delete(k)
    store.set(key, { ...value, ts: now })
  }

  function get(key) {
    return store.get(key)
  }

  function del(key) {
    store.delete(key)
  }

  return { set, get, delete: del }
}

module.exports = { createTtlCache }
