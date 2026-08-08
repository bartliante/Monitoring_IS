// Everything about treating an iflow as a downloadable/uploadable ZIP artifact,
// called directly against the Manage Integration Content API — same
// go-around-CQN approach as ErrorInformation/$value in monitor-service.js,
// since none of this (binary ZIP download/upload, deploy trigger) is
// expressible as a CQN SELECT.

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { rawRequest, odataKey } = require('./remote-connect')

// Seed ZIP for "Diseño de iflow" > Crear: a minimal iflow with no steps,
// exported from Integration Suite. The AI only adds/edits steps inside this
// already-valid skeleton instead of generating MANIFEST.MF/metainfo.prop/the
// whole .iflw structure from scratch.
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'empty-iflow-template.zip')

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

// Same idea as applyFixToZip but for the "Diseño de iflow" flow, where the AI
// can touch several files at once (the .iflw plus any scripts it adds) —
// updates existing entries and adds new ones (e.g. a brand-new script) alike.
function applyFilesToZip(zipBuffer, files) {
  const zip = new AdmZip(zipBuffer)
  for (const { path: filePath, content } of files) {
    const entry = zip.getEntry(filePath)
    if (entry) zip.updateFile(entry, Buffer.from(content, 'utf8'))
    else zip.addFile(filePath, Buffer.from(content, 'utf8'))
  }
  return zip.toBuffer()
}

// Escapes a value for a Java .properties file (metainfo.prop): backslashes
// and non-ASCII chars as \\uXXXX, matching what java.util.Properties#store
// itself produces.
function escapeJavaProperties(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/[^\x00-\x7E]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

// Rewrites the seed template's identity (BPMN2 element ids inside the .iflw
// itself are purely local to that file and don't need to change — verified
// by inspecting a real exported template) so the new iflow doesn't carry the
// template's own Id/Name into the tenant:
// - the .iflw file itself is renamed to '<id>.iflw' (CPI convention: the
//   filename matches the artifact's technical/symbolic name)
// - META-INF/MANIFEST.MF: Bundle-Name/Bundle-SymbolicName/Origin-Bundle-*
// - .project: <name>
// - metainfo.prop: description/source/target (cosmetic — the Web UI's design
//   summary; the actual Sender/Receiver seen by Monitoring come from the
//   OData entity fields set via createIflowZip, not from this file)
function buildIflowFromTemplate({ id, name, description, sender, receiver }) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Falta la plantilla de iflow vacío en '${TEMPLATE_PATH}' — expórtala desde Integration Suite y colócala ahí`)
  }
  const zip = new AdmZip(fs.readFileSync(TEMPLATE_PATH))

  const flowDir = 'src/main/resources/scenarioflows/integrationflow/'
  const flowEntry = zip.getEntries().find(e => e.entryName.startsWith(flowDir) && e.entryName.endsWith('.iflw'))
  if (!flowEntry) throw new Error('La plantilla de iflow vacío no contiene un fichero .iflw — revisa el ZIP')
  const flowData = flowEntry.getData()
  zip.deleteFile(flowEntry.entryName)
  zip.addFile(`${flowDir}${id}.iflw`, flowData)

  const manifestEntry = zip.getEntry('META-INF/MANIFEST.MF')
  if (manifestEntry) {
    const manifest = manifestEntry.getData().toString('utf8')
      .replace(/^Bundle-Name: .*$/m, `Bundle-Name: ${name}`)
      .replace(/^Bundle-SymbolicName: .*$/m, `Bundle-SymbolicName: ${id}; singleton:=true`)
      .replace(/^Origin-Bundle-Name: .*$/m, `Origin-Bundle-Name: ${name}`)
      .replace(/^Origin-Bundle-SymbolicName: .*$/m, `Origin-Bundle-SymbolicName: ${id}`)
    zip.updateFile(manifestEntry, Buffer.from(manifest, 'utf8'))
  }

  const projectEntry = zip.getEntry('.project')
  if (projectEntry) {
    const project = projectEntry.getData().toString('utf8')
      .replace(/<name>[^<]*<\/name>/, `<name>${id}</name>`)
    zip.updateFile(projectEntry, Buffer.from(project, 'utf8'))
  }

  const metainfoEntry = zip.getEntry('metainfo.prop')
  if (metainfoEntry) {
    const metainfo = metainfoEntry.getData().toString('utf8')
      .replace(/^description=.*$/m, `description=${escapeJavaProperties(description)}`)
      .replace(/^source=.*$/m, `source=${escapeJavaProperties(sender)}`)
      .replace(/^target=.*$/m, `target=${escapeJavaProperties(receiver)}`)
    zip.updateFile(metainfoEntry, Buffer.from(metainfo, 'utf8'))
  }

  return zip.toBuffer()
}

// POST on the collection only ever creates a NEW artifact — reusing an
// existing Id 500s with "already exists ... use a different ID" (verified
// against a real tenant). Updating the content of an existing iflow is a PUT
// on the keyed entity instead (standard OData semantics: POST /collection =
// create, PUT /collection(key) = replace) — the Id doesn't go in the body
// since it's already the entity key in the URL.
async function uploadIflowZip(system, { artifactId, packageId, name, description, sender, receiver, zipBuffer }) {
  return rawRequest(
    system,
    `/IntegrationDesigntimeArtifacts(Id=${odataKey(artifactId)},Version=${odataKey('active')})`,
    {
      method: 'put',
      headers: { 'Content-Type': 'application/json' },
      data: {
        PackageId: packageId,
        Name: name,
        Description: description,
        Sender: sender,
        Receiver: receiver,
        ArtifactContent: zipBuffer.toString('base64')
      }
    }
  )
}

// POST /collection creates a NEW artifact (see uploadIflowZip's comment for
// why that endpoint can't be reused for updates) — this is "Diseño de iflow"
// > Crear's write path. Description/Sender/Receiver in the POST body 500s
// with an empty error message (verified against a real tenant) — the create
// endpoint only accepts Id/PackageId/Name/ArtifactContent. Those three extra
// fields DO work on the immediate follow-up PUT (also verified), so create
// with the minimal body, then reuse uploadIflowZip right after to set them.
async function createIflowZip(system, { artifactId, packageId, name, description, sender, receiver, zipBuffer }) {
  await rawRequest(
    system,
    '/IntegrationDesigntimeArtifacts',
    {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      data: {
        Id: artifactId,
        PackageId: packageId,
        Name: name,
        ArtifactContent: zipBuffer.toString('base64')
      }
    }
  )
  return uploadIflowZip(system, { artifactId, packageId, name, description, sender, receiver, zipBuffer })
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
  applyFilesToZip,
  buildIflowFromTemplate,
  uploadIflowZip,
  createIflowZip,
  deployArtifact
}
