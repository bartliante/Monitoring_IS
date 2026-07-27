const cds = require('@sap/cds')
const { SELECT } = cds.ql

const destinationsAdmin = require('./lib/destinations-admin')
const { getRemoteFor, invalidate, rawGet } = require('./lib/remote-connect')
const { translateMessageProcessingLogsQuery, criticalityForStatus } = require('./lib/query-translate')

// OData v2 key segment: 'value' with embedded single quotes doubled.
const odataKey = value => `'${String(value).replace(/'/g, "''")}'`

module.exports = cds.service.impl(async function () {
  const { Systems, Artifacts, MessageProcessingLogs } = this.entities

  this.on('READ', Systems, async () => destinationsAdmin.list())

  // A bug (or a transient network/remote-service error) thrown here isn't just
  // a failed request — an uncaught error inside one of these handlers takes
  // the *whole server* down (verified twice: an unwrapped fetch() rejection,
  // then a .forEach() on a non-array result both did a full "server shutdown",
  // not a clean 500). Every handler below is wrapped accordingly.

  this.on('READ', Artifacts, async req => {
    const system = req.headers['x-system-destination']
    if (!system) return []
    try {
      const remote = await getRemoteFor(system)
      const artifacts = await remote.run(SELECT.from('IntegrationRuntimeArtifacts').columns('Id', 'Name'))
      return artifacts.map(a => ({ Id: a.Id, Name: a.Name }))
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('READ', MessageProcessingLogs, async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    try {
      const remote = await getRemoteFor(system)
      const remoteQuery = translateMessageProcessingLogsQuery(req.query, 'MessageProcessingLogs')
      const results = await remote.run(remoteQuery)
      // A single-key read (Object Page) returns one plain object, not an array —
      // mutate in place (not .map()) so any extra properties CAP attaches to a
      // list result (e.g. for $count) survive.
      const rows = Array.isArray(results) ? results : [results]
      rows.forEach(row => { if (row) row.StatusCriticality = criticalityForStatus(row.Status) })
      return results
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('getErrorTrace', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    const { messageGuid } = req.data
    try {
      return await rawGet(system, `/MessageProcessingLogs(${odataKey(messageGuid)})/ErrorInformation/$value`)
    } catch (e) {
      // No error info for this message (e.g. it never failed) — empty, not an error.
      if (e.response?.status === 404) return ''
      return req.reject(500, e.message)
    }
  })

  this.on('getAttachments', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    const { messageGuid } = req.data
    try {
      const listText = await rawGet(system, `/MessageProcessingLogs(${odataKey(messageGuid)})/Attachments?$format=json`)
      let entries = []
      try { entries = JSON.parse(listText).d.results } catch { entries = [] }
      return await Promise.all(entries.map(async e => {
        const mediaSrc = e.__metadata?.media_src || e.media_src
        let content = ''
        if (mediaSrc) {
          try { content = await rawGet(system, mediaSrc) } catch { content = '' }
        }
        return { Id: e.Id, Name: e.Name, ContentType: e.ContentType, Content: content }
      }))
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('createConnection', async req => {
    const { name, apiUrl, tokenUrl, clientId, clientSecret } = req.data
    if (!name || !apiUrl || !tokenUrl || !clientId || !clientSecret) {
      return req.reject(400, 'Todos los campos son obligatorios')
    }
    invalidate(name)
    try {
      return await destinationsAdmin.create({ name, apiUrl, tokenUrl, clientId, clientSecret })
    } catch (e) {
      return req.reject(400, e.message)
    }
  })

  this.on('deleteConnection', async req => {
    const { name } = req.data
    invalidate(name)
    await destinationsAdmin.remove(name)
  })
})
