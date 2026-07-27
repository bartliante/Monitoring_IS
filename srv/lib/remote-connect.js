const cds = require('@sap/cds')
const destinationsAdmin = require('./destinations-admin')

// RemoteService connections keyed by destination name. Only used (and only
// safe to keep long-lived) for the real BTP Destination service path: there,
// Cloud SDK resolves + authenticates against the live destination on every
// request, so a cached connection never goes stale. The local dev path never
// populates this cache — see getRemoteFor.
const connections = new Map()

async function getRemoteFor(destinationName) {
  if (!destinationName) throw new Error('destinationName is required')

  // cds.connect.to(name, options) merges `{ kind, ...conf, ...options }` at the
  // top level only — passing `credentials` here REPLACES cds.requires
  // .CloudIntegrationAPI.credentials wholesale rather than merging into it, so
  // the static `path: '/api/v1'` (needed to reach the remote system's actual
  // API path, not just its host) has to be spread back in explicitly here.
  const staticCredentials = cds.env.requires.CloudIntegrationAPI.credentials

  if (destinationsAdmin.hasRealDestinationService()) {
    if (!connections.has(destinationName)) {
      connections.set(destinationName, cds.connect.to('CloudIntegrationAPI', {
        credentials: { ...staticCredentials, destination: destinationName }
      }))
    }
    return connections.get(destinationName)
  }

  // Local dev: resolve to the destination's url/auth/token inline instead of
  // by name (see resolveLocalCredentials for why), fetching a fresh token on
  // every call since nothing here would ever refresh one cached on a
  // long-lived connection.
  const dynamicCredentials = await destinationsAdmin.resolveLocalCredentials(destinationName)
  return cds.connect.to('CloudIntegrationAPI', {
    credentials: { ...staticCredentials, ...dynamicCredentials }
  })
}

function invalidate(destinationName) {
  connections.delete(destinationName)
}

module.exports = { getRemoteFor, invalidate }
