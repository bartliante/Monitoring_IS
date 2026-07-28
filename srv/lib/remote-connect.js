const cds = require('@sap/cds')
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
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

// For endpoints that aren't plain entity CRUD (media/stream resources like
// ErrorInformation/$value or Attachments/$value, convenience params like
// $format=json, or non-GET calls like uploading/deploying an iflow) there's
// no CQN to build — go around the RemoteService/CQN layer entirely and call
// the destination directly via Cloud SDK's HTTP client. Mirrors
// getRemoteFor's local-vs-BTP split: BTP resolves fully by name (its own
// token handling); local passes the same inline url/auth/token object used
// elsewhere, for the same reasons as getRemoteFor.
async function rawRequest(destinationName, urlOrPath, { method = 'get', data, responseType = 'text', headers } = {}) {
  const destination = destinationsAdmin.hasRealDestinationService()
    ? { destinationName }
    : await destinationsAdmin.resolveLocalCredentials(destinationName)

  const staticCredentials = cds.env.requires.CloudIntegrationAPI.credentials
  const isAbsolute = /^https?:\/\//i.test(urlOrPath)
  const url = isAbsolute ? urlOrPath : `${staticCredentials.path || ''}${urlOrPath}`

  try {
    const response = await executeHttpRequest(destination, { method, url, data, responseType, headers })
    return response.data
  } catch (e) {
    // Cloud SDK/axios's own error message is just "Request failed with status
    // code 400" — the actual reason (CPI returns a JSON/XML body describing
    // what's wrong) is in e.response.data, which gets silently dropped unless
    // surfaced here.
    if (e.response) {
      const body = Buffer.isBuffer(e.response.data) ? e.response.data.toString('utf8') : e.response.data
      const detail = typeof body === 'string' ? body : JSON.stringify(body)
      const error = new Error(`${method.toUpperCase()} ${url} -> ${e.response.status}: ${(detail || '').slice(0, 1000)}`)
      error.response = e.response
      throw error
    }
    throw e
  }
}

async function rawGet(destinationName, urlOrPath) {
  return rawRequest(destinationName, urlOrPath, { method: 'get', responseType: 'text' })
}

// OData v2 key segment: 'value' with embedded single quotes doubled.
const odataKey = value => `'${String(value).replace(/'/g, "''")}'`

module.exports = { getRemoteFor, invalidate, rawGet, rawRequest, odataKey }
