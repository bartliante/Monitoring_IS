const cds = require('@sap/cds')
const { SELECT } = cds.ql

const destinationsAdmin = require('./lib/destinations-admin')
const { getRemoteFor, invalidate, rawGet, odataKey } = require('./lib/remote-connect')
const { translateMessageProcessingLogsQuery, criticalityForStatus } = require('./lib/query-translate')
const {
  downloadIflowZip, extractRelevantFiles, applyFixToZip, uploadIflowZip, deployArtifact
} = require('./lib/iflow-content')
const { diagnoseAndFix } = require('./lib/ai-fix')

// Holds, between "Analizar con IA" and "Aplicar corrección y desplegar", the
// iflow ZIP/metadata the second step needs so it doesn't have to re-download
// and the user can freely edit the proposed code in between. In-memory only
// (same spirit as remote-connect.js's `connections` cache) — a server
// restart just means the user has to re-analyze, which is an acceptable cost
// for not needing a real datastore for this transient state.
const aiCache = new Map()
const AI_CACHE_TTL_MS = 30 * 60 * 1000

function rememberAiContext(key, value) {
  const now = Date.now()
  for (const [k, v] of aiCache) if (now - v.ts > AI_CACHE_TTL_MS) aiCache.delete(k)
  aiCache.set(key, { ...value, ts: now })
}

// Shared by the getAttachments handler and analyzeError (which feeds the same
// attachments to Claude as extra evidence alongside the error trace).
async function fetchAttachments(system, messageGuid) {
  const listText = await rawGet(system, `/MessageProcessingLogs(${odataKey(messageGuid)})/Attachments?$format=json`)
  let entries = []
  try { entries = JSON.parse(listText).d.results } catch { entries = [] }
  return Promise.all(entries.map(async e => {
    const mediaSrc = e.__metadata?.media_src || e.media_src
    let content = ''
    if (mediaSrc) {
      try { content = await rawGet(system, mediaSrc) } catch { content = '' }
    }
    return { Id: e.Id, Name: e.Name, ContentType: e.ContentType, Content: content }
  }))
}

// IntegrationArtifact (with the iflow's technical Id/PackageId) comes back
// inline on a plain MessageProcessingLogs read already — it's a nested
// structure, not a navigation property, so $expand is rejected outright by
// the real API ("Property 'IntegrationArtifact' must be a navigation
// property", verified against a real tenant). Plain $format=json is enough.
async function fetchLogWithArtifact(system, messageGuid) {
  const text = await rawGet(system, `/MessageProcessingLogs(${odataKey(messageGuid)})?$format=json`)
  return JSON.parse(text).d
}

module.exports = cds.service.impl(async function () {
  const { Systems, Artifacts, MessageProcessingLogs, StatusValues } = this.entities

  this.on('READ', Systems, async () => destinationsAdmin.list())

  // Reads the Spanish text straight off the Status enum's own
  // @Core.Description (monitor-service.cds) instead of duplicating it here.
  this.on('READ', StatusValues, async () => {
    const { enum: statusEnum } = cds.model.definitions['Status']
    return Object.entries(statusEnum).map(([Code, def]) => ({ Code, Text: def['@Core.Description'] || Code }))
  })

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
      return await fetchAttachments(system, messageGuid)
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('analyzeError', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    const { messageGuid } = req.data
    try {
      const log = await fetchLogWithArtifact(system, messageGuid)
      if (!log || !log.IntegrationArtifact) return req.reject(404, 'No se encontró la ejecución o su iflow asociado')
      const { Id: artifactId, PackageId: packageId } = log.IntegrationArtifact

      const [errorTrace, attachments] = await Promise.all([
        rawGet(system, `/MessageProcessingLogs(${odataKey(messageGuid)})/ErrorInformation/$value`).catch(() => ''),
        fetchAttachments(system, messageGuid).catch(() => [])
      ])
      const zipBuffer = await downloadIflowZip(system, artifactId)
      const { flowXml, scripts } = extractRelevantFiles(zipBuffer)

      const suggestion = await diagnoseAndFix({ errorTrace, attachments, flowXml, scripts, logContext: log })
      const currentCode = [...flowXml, ...scripts].find(f => f.path === suggestion.filePath)?.content || ''

      rememberAiContext(`${system}::${messageGuid}`, {
        artifactId, packageId, name: log.IntegrationFlowName, zipBuffer
      })

      return {
        Diagnosis: suggestion.diagnosis,
        FilePath: suggestion.filePath,
        CurrentCode: currentCode,
        ProposedCode: suggestion.proposedCode,
        Explanation: suggestion.explanation
      }
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('applyFixAndDeploy', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    const { messageGuid, filePath, proposedCode } = req.data
    const cached = aiCache.get(`${system}::${messageGuid}`)
    if (!cached) return req.reject(400, 'Vuelve a analizar el error antes de aplicar la corrección (la información ya no está disponible)')
    try {
      const newZip = applyFixToZip(cached.zipBuffer, filePath, proposedCode)
      await uploadIflowZip(system, { artifactId: cached.artifactId, packageId: cached.packageId, name: cached.name, zipBuffer: newZip })
      const taskId = await deployArtifact(system, cached.artifactId)
      aiCache.delete(`${system}::${messageGuid}`)
      return { Success: true, TaskId: String(taskId), Message: 'Corrección aplicada y despliegue iniciado' }
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
