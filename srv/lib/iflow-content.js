// Everything about treating an iflow as a downloadable/uploadable ZIP artifact,
// called directly against the Manage Integration Content API — same
// go-around-CQN approach as ErrorInformation/$value in monitor-service.js,
// since none of this (binary ZIP download/upload, deploy trigger) is
// expressible as a CQN SELECT.

const AdmZip = require('adm-zip')
const { rawRequest, odataKey } = require('./remote-connect')

// Combined size cap for what gets sent to Claude — keeps the request small
// and bounded regardless of how large a given iflow's ZIP is.
const MAX_TOTAL_BYTES = 150 * 1024

async function downloadIflowZip(system, artifactId) {
  const data = await rawRequest(
    system,
    `/IntegrationDesigntimeArtifacts(Id=${odataKey(artifactId)},Version=${odataKey('active')})/$value`,
    { responseType: 'arraybuffer' }
  )
  return Buffer.from(data)
}

// Files worth sending to Claude: the graphical flow definition (so it can
// relate component names from the error trace to actual steps) plus the
// scripts/mappings that are the only things it's asked to fix.
const RELEVANT_PATH_PATTERNS = [
  /^src\/main\/resources\/scenarioflows\/integrationflow\/.*\.iflw$/,
  /^src\/main\/resources\/script\/.*/,
  /^src\/main\/resources\/mapping\/.*/
]

function extractRelevantFiles(zipBuffer) {
  const zip = new AdmZip(zipBuffer)
  const flowXml = []
  const scripts = []
  let totalBytes = 0

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const path = entry.entryName
    const isFlow = /\.iflw$/.test(path) && RELEVANT_PATH_PATTERNS[0].test(path)
    const isScript = RELEVANT_PATH_PATTERNS[1].test(path) || RELEVANT_PATH_PATTERNS[2].test(path)
    if (!isFlow && !isScript) continue

    const content = entry.getData().toString('utf8')
    if (totalBytes + content.length > MAX_TOTAL_BYTES) continue
    totalBytes += content.length

    ;(isFlow ? flowXml : scripts).push({ path, content })
  }

  return { flowXml, scripts }
}

function applyFixToZip(zipBuffer, filePath, newContent) {
  const zip = new AdmZip(zipBuffer)
  const entry = zip.getEntry(filePath)
  if (!entry) throw new Error(`'${filePath}' ya no existe dentro del iflow — vuelve a analizar el error`)
  zip.updateFile(entry, Buffer.from(newContent, 'utf8'))
  return zip.toBuffer()
}

// POST on the collection only ever creates a NEW artifact — reusing an
// existing Id 500s with "already exists ... use a different ID" (verified
// against a real tenant). Updating the content of an existing iflow is a PUT
// on the keyed entity instead (standard OData semantics: POST /collection =
// create, PUT /collection(key) = replace) — the Id doesn't go in the body
// since it's already the entity key in the URL.
async function uploadIflowZip(system, { artifactId, packageId, name, zipBuffer }) {
  return rawRequest(
    system,
    `/IntegrationDesigntimeArtifacts(Id=${odataKey(artifactId)},Version=${odataKey('active')})`,
    {
      method: 'put',
      headers: { 'Content-Type': 'application/json' },
      data: {
        PackageId: packageId,
        Name: name,
        ArtifactContent: zipBuffer.toString('base64')
      }
    }
  )
}

async function deployArtifact(system, artifactId) {
  return rawRequest(
    system,
    `/DeployIntegrationDesigntimeArtifact?Id=${odataKey(artifactId)}&Version=${odataKey('active')}`,
    { method: 'post' }
  )
}

module.exports = {
  downloadIflowZip,
  extractRelevantFiles,
  applyFixToZip,
  uploadIflowZip,
  deployArtifact
}
