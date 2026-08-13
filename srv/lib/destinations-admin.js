const cds = require('@sap/cds')
const fs = require('fs')
const path = require('path')

// Marks destinations created by this app so the "system" dropdown only ever shows
// those, and never e.g. the `srv-api` destination used by the approuter.
const TAG = 'IntegrationSuiteMonitor'

// Whether to talk to the real BTP Destination service or fall back to the
// local file: driven by whether a "destination" service instance is actually
// bound, not by whether we're nominally running on Cloud Foundry. @sap/cds
// parses VCAP_SERVICES itself (see cds.requires.destinations: true in
// package.json) and populates cds.env.requires.destinations.credentials the
// moment it finds one — in a real deployment that's automatic; locally you
// get the same effect by pasting a destination service key's VCAP_SERVICES
// into `.env` (gitignored) and uncommenting it, exactly like this project's
// CargaEmpleados sibling does for its own destination service integration.
const hasRealDestinationService = () => !!cds.env.requires?.destinations?.credentials

// Just requiring @sap/cds already parses default-env.json and copies its top-level
// "destinations" key onto process.env.destinations (a Cloud SDK/BAS convention, see
// resolveLocalCredentials below) — regardless of whether a real destination service is
// bound. @sap-cloud-sdk/connectivity's destination lookup checks that env var BEFORE
// calling the real BTP Destination service, so a locally-stored entry with the same
// Name as a real one (e.g. both called "trial") silently wins and gets used for auth —
// verified against a real tenant: the real call failed with "no auth tokens could be
// fetched from the destination service" because the env-var entry has no real token,
// only the fake/demo credentials typed into default-env.json for local testing. Once a
// real destination service is bound, that env var must never be consulted at all, so it
// gets cleared here, once, before any remote call can happen.
if (hasRealDestinationService()) delete process.env.destinations

// Network-level failures (DNS, connection refused, timeout...) make the global
// `fetch` reject with a TypeError whose message is just "fetch failed" — and,
// unlike an HTTP error response, that rejection isn't something CDS's request
// dispatch turns into a clean error response; left unwrapped it crashes the
// whole process (verified: an unreachable Destination service host took the
// entire server down instead of returning a 500 to the one request that hit
// it). Wrapping every outbound call here turns that into an ordinary thrown
// Error with a useful message instead.
async function safeFetch(url, options) {
  try {
    return await fetch(url, options)
  } catch (e) {
    throw new Error(`No se pudo contactar con ${url}: ${e.cause?.message || e.message}`)
  }
}

// Local destinations are persisted in default-env.json at the project root
// (gitignored). IMPORTANT: `cds watch` watches every `.json` file it finds
// there by default, so writing to this file from within a running request
// (creating/deleting a connection) makes `cds watch` restart the whole server
// mid-request. Run the app with `npm run watch` (not a bare `cds watch`) —
// see the "watch" script in package.json, which passes
// `--exclude default-env.json` for exactly this reason.
const DEFAULT_ENV_PATH = path.join(cds.root, 'default-env.json')

function readLocalDestinations() {
  try {
    const env = JSON.parse(fs.readFileSync(DEFAULT_ENV_PATH, 'utf8'))
    return env.destinations || []
  } catch {
    return []
  }
}

function writeLocalDestinations(destinations) {
  let env = {}
  try { env = JSON.parse(fs.readFileSync(DEFAULT_ENV_PATH, 'utf8')) } catch { /* first write */ }
  env.destinations = destinations
  fs.writeFileSync(DEFAULT_ENV_PATH, JSON.stringify(env, null, 2))
}

async function fetchOAuth2Token(tokenServiceUrl, clientId, clientSecret) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await safeFetch(tokenServiceUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  })
  if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`)
  return res.json()
}

// Builds ready-to-use `credentials` for cds.connect.to(..., { credentials })
// for a locally-stored destination: url/authentication plus a freshly-fetched
// OAuth token (attached as `authTokens`, the shape Cloud SDK's own header
// building expects — see authorization-header.js: getAuthenticationRelatedHeaders,
// which for OAuth2ClientCredentials only ever reads `destination.authTokens`,
// never fetches a token itself).
//
// Deliberately NOT resolved by destination *name* (no `credentials.destination`
// key): when a name is given, @sap/cds's RemoteService asks the Cloud SDK to
// look the destination up, and that lookup checks `process.env.destinations`
// (a Cloud SDK/BAS convention we don't control — some BAS setups populate it
// from this same default-env.json for `cds bind`-style tooling) BEFORE
// anything registered programmatically, so a same-named entry there without
// auth tokens would silently win and break auth. Passing the full destination
// inline skips that lookup entirely (see @sap/cds's remote Service.js —
// `credentials.destination` present is what triggers the by-name path).
async function resolveLocalCredentials(name) {
  const found = readLocalDestinations().find(d => d.name === name && d[TAG] === 'true')
  if (!found) throw new Error(`No existe una conexión local llamada '${name}'`)

  const credentials = { url: found.url, authentication: found.authentication }
  if (found.authentication === 'OAuth2ClientCredentials') {
    const { access_token } = await fetchOAuth2Token(found.tokenServiceURL, found.clientId, found.clientSecret)
    credentials.authTokens = [{
      type: 'Bearer',
      value: access_token,
      error: null,
      http_header: { key: 'Authorization', value: `Bearer ${access_token}` }
    }]
  }
  return credentials
}

async function listLocal() {
  return readLocalDestinations()
    .filter(d => d[TAG] === 'true')
    .map(d => ({ Name: d.name, DisplayName: d.name, Url: d.url }))
}

async function createLocal({ name, apiUrl, tokenUrl, clientId, clientSecret }) {
  const destinations = readLocalDestinations()
  if (destinations.some(d => d.name === name)) throw new Error(`Ya existe una conexión llamada '${name}'`)
  destinations.push({
    name,
    url: apiUrl,
    authentication: 'OAuth2ClientCredentials',
    tokenServiceURL: tokenUrl,
    clientId,
    clientSecret,
    [TAG]: 'true'
  })
  writeLocalDestinations(destinations)
  await registerLocalDestinations()
  return { Name: name, DisplayName: name, Url: apiUrl }
}

async function removeLocal(name) {
  writeLocalDestinations(readLocalDestinations().filter(d => d.name !== name))
  // Note: the Cloud SDK registry has no "unregister" primitive, so a removed
  // destination's credentials can linger in-process until restart. It no
  // longer appears in list(), which is what drives the system dropdown.
}

// ---------------------------------------------------------------------------
// Real BTP Destination service: self-service via the Destination Configuration
// API, authenticating with the OAuth client of the bound destination service
// instance itself (no separate admin credentials needed).
// ---------------------------------------------------------------------------

async function getServiceCredentials() {
  const credentials = cds.env.requires?.destinations?.credentials
  if (!credentials) throw new Error('No destination service binding found (cds.env.requires.destinations.credentials)')
  const placeholder = ['clientid', 'clientsecret', 'url', 'uri'].find(k => typeof credentials[k] === 'string' && /^</.test(credentials[k]))
  if (placeholder) throw new Error(
    `El VCAP_SERVICES de .env todavía tiene el placeholder "${credentials[placeholder]}" en "${placeholder}" — sustitúyelo por el valor real de la Service Key de tu instancia del Destination service.`
  )
  return credentials
}

async function getServiceToken() {
  const { clientid, clientsecret, url } = await getServiceCredentials()
  const basic = Buffer.from(`${clientid}:${clientsecret}`).toString('base64')
  const res = await safeFetch(`${url}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  })
  if (!res.ok) throw new Error(`No se pudo obtener el token del Destination service: ${res.status} ${await res.text()}`)
  return (await res.json()).access_token
}

async function listBtp() {
  const { uri } = await getServiceCredentials()
  const token = await getServiceToken()
  const res = await safeFetch(`${uri}/destination-configuration/v1/subaccountDestinations`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`No se pudieron listar las destinations: ${res.status} ${await res.text()}`)
  const all = await res.json()
  return all
    .filter(d => d[TAG] === 'true')
    .map(d => ({ Name: d.Name, DisplayName: d.Name, Url: d.URL }))
}

async function createBtp({ name, apiUrl, tokenUrl, clientId, clientSecret }) {
  const { uri } = await getServiceCredentials()
  const token = await getServiceToken()
  const res = await safeFetch(`${uri}/destination-configuration/v1/subaccountDestinations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Name: name,
      Type: 'HTTP',
      URL: apiUrl,
      ProxyType: 'Internet',
      Authentication: 'OAuth2ClientCredentials',
      tokenServiceURL: tokenUrl,
      tokenServiceURLType: 'Dedicated',
      clientId,
      clientSecret,
      [TAG]: 'true'
    })
  })
  if (!res.ok) throw new Error(`No se pudo crear la destination: ${res.status} ${await res.text()}`)
  return { Name: name, DisplayName: name, Url: apiUrl }
}

async function removeBtp(name) {
  const { uri } = await getServiceCredentials()
  const token = await getServiceToken()
  const res = await safeFetch(`${uri}/destination-configuration/v1/subaccountDestinations/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok && res.status !== 404) throw new Error(`No se pudo borrar la destination: ${res.status} ${await res.text()}`)
}

module.exports = {
  list: () => (hasRealDestinationService() ? listBtp() : listLocal()),
  create: data => (hasRealDestinationService() ? createBtp(data) : createLocal(data)),
  remove: name => (hasRealDestinationService() ? removeBtp(name) : removeLocal(name)),
  hasRealDestinationService,
  resolveLocalCredentials
}
