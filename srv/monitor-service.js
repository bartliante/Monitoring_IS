const cds = require('@sap/cds')
const { SELECT } = cds.ql

const destinationsAdmin = require('./lib/destinations-admin')
const { getRemoteFor, invalidate, rawGet, rawRequest, odataKey } = require('./lib/remote-connect')
const { translateMessageProcessingLogsQuery, criticalityForStatus } = require('./lib/query-translate')
const {
  downloadIflowZip, extractRelevantFiles, applyFixToZip, applyFilesToZip, buildIflowFromTemplate,
  uploadIflowZip, createIflowZip, deployArtifact
} = require('./lib/iflow-content')
const { diagnoseAndFix } = require('./lib/ai-fix')
const { designIflow: designIflowWithAi } = require('./lib/ai-iflow')
const { extractText } = require('./lib/document-text')
const { createTtlCache } = require('./lib/ttl-cache')

// Holds, between the "propose" and "confirm" steps of each two-step AI flow,
// the iflow ZIP/metadata the second step needs so it doesn't have to
// re-download/re-build and the user can freely review in between. Same TTL
// cache for both: "Analizar con IA" -> "Aplicar corrección y desplegar"
// (aiCache, keyed by messageGuid) and "Diseño de iflow" propose -> confirm
// (iflowDesignCache, keyed by artifactId) — separate maps so the two flows'
// keys can never collide.
const AI_CACHE_TTL_MS = 30 * 60 * 1000
const aiCache = createTtlCache(AI_CACHE_TTL_MS)
const iflowDesignCache = createTtlCache(AI_CACHE_TTL_MS)

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
  const { Systems, Artifacts, MessageProcessingLogs, StatusValues, IntegrationPackages } = this.entities

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

  this.on('READ', IntegrationPackages, async req => {
    const system = req.headers['x-system-destination']
    if (!system) return []
    try {
      const remote = await getRemoteFor(system)
      // No .columns() here — unlike IntegrationRuntimeArtifacts (see Artifacts above),
      // this entity's real API 500s on "$select is not supported" (verified against a
      // real tenant), so the column restriction has to happen in JS after a plain read.
      const packages = await remote.run(SELECT.from('IntegrationPackages'))
      return packages.map(p => ({ Id: p.Id, Name: p.Name }))
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('getPackageArtifacts', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de continuar')
    const { packageId } = req.data
    try {
      const text = await rawGet(system, `/IntegrationPackages(${odataKey(packageId)})/IntegrationDesigntimeArtifacts?$format=json`)
      const results = JSON.parse(text).d.results || []
      return results.map(a => ({ Id: a.Id, Name: a.Name, Version: a.Version }))
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('getIflowDetails', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de continuar')
    const { artifactId } = req.data
    try {
      // No "?$format=json" here — verified against a real tenant that this exact
      // combination (single-key GET on this entity + explicit $format=json) 501s
      // with "No message reference given", for both brand-new and long-existing
      // deployed iflows alike. The plain GET already comes back as JSON by default.
      const text = await rawGet(system, `/IntegrationDesigntimeArtifacts(Id=${odataKey(artifactId)},Version=${odataKey('active')})`)
      const d = JSON.parse(text).d
      return {
        Id: d.Id, PackageId: d.PackageId, Name: d.Name,
        Description: d.Description || '', Sender: d.Sender || '', Receiver: d.Receiver || ''
      }
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

      aiCache.set(`${system}::${messageGuid}`, {
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

  this.on('designIflow', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de continuar')
    const {
      mode, packageId, artifactId, artifactName, description, sender, receiver,
      aiInputMode, prompt, designDocument, designDocumentName
    } = req.data
    if (!packageId || !artifactId || !artifactName) {
      return req.reject(400, 'Paquete, nombre e ID del iflow son obligatorios')
    }
    try {
      let requirements = prompt
      if (aiInputMode === 'DOCUMENT') {
        if (!designDocument) return req.reject(400, 'Adjunta un diseño técnico')
        requirements = await extractText(Buffer.from(designDocument, 'base64'), designDocumentName)
      }
      if (!requirements) return req.reject(400, 'Especifica un prompt o adjunta un diseño técnico')

      const zipBuffer = mode === 'CREATE'
        ? buildIflowFromTemplate({ id: artifactId, name: artifactName, description, sender, receiver })
        : await downloadIflowZip(system, artifactId)
      const { flowXml, scripts, parameters } = extractRelevantFiles(zipBuffer)

      const proposal = await designIflowWithAi({ mode, artifactName, description, sender, receiver, requirements, flowXml, scripts, parameters })
      const newZip = applyFilesToZip(zipBuffer, proposal.files)

      iflowDesignCache.set(`${system}::${artifactId}`, {
        mode, packageId, artifactId, artifactName, description, sender, receiver, zipBuffer: newZip
      })

      // .iflw completo tras aplicar los cambios (no el preview truncado de Files) —
      // el frontend lo parsea (BPMNDI) para dibujar un esquema simplificado.
      const { flowXml: newFlowXml } = extractRelevantFiles(newZip)

      return {
        Summary: proposal.summary,
        Warnings: proposal.warnings || '',
        Files: proposal.files.map(f => ({ Path: f.path, Preview: f.content.slice(0, 500) })),
        Diagram: newFlowXml[0]?.content || ''
      }
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('confirmIflowDesign', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de continuar')
    const { artifactId } = req.data
    const cached = iflowDesignCache.get(`${system}::${artifactId}`)
    if (!cached) return req.reject(400, 'Vuelve a generar la propuesta antes de confirmar (la información ya no está disponible)')
    try {
      const writeArgs = {
        artifactId: cached.artifactId, packageId: cached.packageId, name: cached.artifactName,
        description: cached.description, sender: cached.sender, receiver: cached.receiver,
        zipBuffer: cached.zipBuffer
      }
      if (cached.mode === 'CREATE') await createIflowZip(system, writeArgs)
      else await uploadIflowZip(system, writeArgs)

      const taskId = await deployArtifact(system, cached.artifactId)
      iflowDesignCache.delete(`${system}::${artifactId}`)
      return {
        Success: true,
        TaskId: String(taskId),
        Message: cached.mode === 'CREATE' ? 'Iflow creado y despliegue iniciado' : 'Iflow actualizado y despliegue iniciado'
      }
    } catch (e) {
      return req.reject(500, e.message)
    }
  })

  this.on('createPackage', async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de continuar')
    const { id, name, shortText } = req.data
    if (!id || !name || !shortText) return req.reject(400, 'Nombre, nombre técnico y descripción corta son obligatorios')
    try {
      await rawRequest(system, '/IntegrationPackages', {
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        data: { Id: id, Name: name, ShortText: shortText }
      })
      return { Id: id, Name: name }
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
