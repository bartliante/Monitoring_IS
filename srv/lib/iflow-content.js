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
// relate component names from the error trace to actual steps), the
// scripts/mappings that are the only things it's asked to fix, and (only used
// by the "Diseño de iflow" flow, ai-iflow-prompt.js) the externalized
// parameters files — needed so the AI can ADD a Timer's "custom:schedule"
// parameter alongside whatever's already there instead of blindly creating a
// parameters.prop that wipes out unrelated existing parameters on Actualizar.
const RELEVANT_PATH_PATTERNS = [
  /^src\/main\/resources\/scenarioflows\/integrationflow\/.*\.iflw$/,
  /^src\/main\/resources\/script\/.*/,
  /^src\/main\/resources\/mapping\/.*/
]
const PARAMETERS_PATHS = ['src/main/resources/parameters.prop', 'src/main/resources/parameters.propdef']

function extractRelevantFiles(zipBuffer) {
  const zip = new AdmZip(zipBuffer)
  const flowXml = []
  const scripts = []
  const parameters = []
  let totalBytes = 0

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const path = entry.entryName
    const isFlow = /\.iflw$/.test(path) && RELEVANT_PATH_PATTERNS[0].test(path)
    const isScript = RELEVANT_PATH_PATTERNS[1].test(path) || RELEVANT_PATH_PATTERNS[2].test(path)
    const isParameters = PARAMETERS_PATHS.includes(path)
    if (!isFlow && !isScript && !isParameters) continue

    const content = entry.getData().toString('utf8')
    if (totalBytes + content.length > MAX_TOTAL_BYTES) continue
    totalBytes += content.length

    if (isFlow) flowXml.push({ path, content })
    else if (isScript) scripts.push({ path, content })
    else parameters.push({ path, content })
  }

  return { flowXml, scripts, parameters }
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

function getAttr(attrText, name) {
  const m = attrText.match(new RegExp(`\\b${name}="([^"]*)"`))
  return m ? m[1] : null
}

// The AI (verified with both Gemini and Claude) reliably wires the logical BPMN2 model
// correctly — every sequenceFlow/messageFlow gets the right sourceRef/targetRef, so the build
// itself doesn't complain — but on larger designs (~40+ flows) has been seen to leave most
// sequenceFlow connections without a matching BPMNEdge in the diagram. The runtime doesn't care
// (the diagram is cosmetic), but the graphical editor then shows the steps floating
// unconnected — verified against a real generated design ("completo", 41 sequenceFlow, only 1
// had an edge; all 9 messageFlow did, so it's specifically the step-to-step lines that get
// dropped). This fills in any missing edge using the BPMNShape bounds the AI DOES reliably
// generate for every element — a straight line between shape centers, not a routed diagram, but
// enough to make the connection visible and avoid a diagram that looks broken/incomplete.
function repairMissingDiagramEdges(iflwContent) {
  const flows = []
  const flowTagRe = /<bpmn2:(?:sequenceFlow|messageFlow)\s+([^>]*?)(?:\/>|>)/g
  let m
  while ((m = flowTagRe.exec(iflwContent))) {
    const id = getAttr(m[1], 'id')
    const from = getAttr(m[1], 'sourceRef')
    const to = getAttr(m[1], 'targetRef')
    if (id && from && to) flows.push({ id, from, to })
  }

  const edgeIds = new Set()
  const edgeTagRe = /<bpmndi:BPMNEdge\s+([^>]*?)>/g
  while ((m = edgeTagRe.exec(iflwContent))) {
    const id = getAttr(m[1], 'bpmnElement')
    if (id) edgeIds.add(id)
  }
  const missing = flows.filter(f => !edgeIds.has(f.id))
  if (!missing.length) return iflwContent

  const shapes = {}
  const shapeBlockRe = /<bpmndi:BPMNShape\s+([^>]*?)>([\s\S]*?)<\/bpmndi:BPMNShape>/g
  while ((m = shapeBlockRe.exec(iflwContent))) {
    const ref = getAttr(m[1], 'bpmnElement')
    const shapeId = getAttr(m[1], 'id')
    const boundsMatch = m[2].match(/<dc:Bounds\s+([^>]*?)\/>/)
    if (!ref || !shapeId || !boundsMatch) continue
    const x = parseFloat(getAttr(boundsMatch[1], 'x'))
    const y = parseFloat(getAttr(boundsMatch[1], 'y'))
    const w = parseFloat(getAttr(boundsMatch[1], 'width'))
    const h = parseFloat(getAttr(boundsMatch[1], 'height'))
    if ([x, y, w, h].some(Number.isNaN)) continue
    shapes[ref] = { shapeId, x, y, w, h }
  }

  let addedCount = 0
  const newEdgesXml = missing.map(f => {
    const s = shapes[f.from]
    const t = shapes[f.to]
    if (!s || !t) return '' // sin las dos figuras no se puede posicionar - se omite, no se inventa
    addedCount++
    const x1 = s.x + s.w / 2, y1 = s.y + s.h / 2
    const x2 = t.x + t.w / 2, y2 = t.y + t.h / 2
    return `<bpmndi:BPMNEdge bpmnElement="${f.id}" id="BPMNEdge_${f.id}_auto" sourceElement="${s.shapeId}" targetElement="${t.shapeId}">` +
      `<di:waypoint x="${x1}" xsi:type="dc:Point" y="${y1}"/><di:waypoint x="${x2}" xsi:type="dc:Point" y="${y2}"/></bpmndi:BPMNEdge>`
  }).join('')

  if (!addedCount) return iflwContent
  return iflwContent.replace('</bpmndi:BPMNPlane>', `${newEdgesXml}</bpmndi:BPMNPlane>`)
}

// Cada adaptador (messageFlow) de la libreria de referencia (ai-iflow-components.js) incluye
// SIEMPRE una property "Name" (la etiqueta visible del adaptador en el panel de configuracion
// real) — verificado que la IA a veces la omite en disenos grandes: un diseno real generado por
// Gemini omitia "Name" en los 9 messageFlow que tenia, y el editor grafico fallaba al abrir el
// iflow con "Technical Error during processing Validation ... NullPointerException: Name is
// null". Se rellena aqui con el atributo "name" del propio messageFlow o con su ComponentType
// como ultimo recurso — nunca se deja sin valor.
function repairMissingAdapterNames(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:messageFlow\s+([^>]*?)>([\s\S]*?)<\/bpmn2:messageFlow>/g,
    (full, openAttrs, body) => {
      if (/<key>Name<\/key>/.test(body)) return full
      const nameAttr = getAttr(openAttrs, 'name')
      const componentTypeMatch = body.match(/<key>ComponentType<\/key>\s*<value>([^<]*)<\/value>/)
      const fallbackName = nameAttr || (componentTypeMatch && componentTypeMatch[1]) || 'Adapter'
      const newProp = `<ifl:property><key>Name</key><value>${fallbackName}</value></ifl:property>`
      const newBody = body.replace('<bpmn2:extensionElements>', `<bpmn2:extensionElements>${newProp}`)
      return `<bpmn2:messageFlow ${openAttrs}>${newBody}</bpmn2:messageFlow>`
    }
  )
}

// Indice "ComponentType::MessageProtocol" (p.ej. "HTTP::None", "SuccessFactors::OData V2") ->
// mapa de todas las properties que trae el messageFlow de ESE componente de referencia,
// construido una sola vez al cargar el modulo. Usado por repairIncompleteAdapterProperties para
// rellenar CUALQUIER property que la IA se deje sin generar (no solo "Name"/"server") con el
// valor real ya verificado de la libreria — mismo criterio que ya usa todo este proyecto (copiar
// de un componente de referencia real en vez de inventar), aplicado ahora tambien como red de
// seguridad post-generacion. La clave NO puede ser solo el "cname" del cmdVariantUri: verificado
// que successfactors-odata-receiver.xml y successfactors-soap-receiver-compoundemployee.xml
// comparten el mismo cname ("sap:SuccessFactors") pese a ser adaptadores distintos (OData V2 vs
// SOAP) — usar solo cname hace que uno pise al otro en el indice y se acaben inyectando
// properties SOAP en un adaptador OData (o viceversa). ComponentType+MessageProtocol+direction
// si los distingue correctamente (direction hace falta ademas por el mismo motivo: Sender y
// Receiver del mismo protocolo, p.ej. soap-receiver.xml/soap-sender.xml, tambien comparten
// ComponentType+MessageProtocol). Limitacion residual conocida y aceptada: mail-sender-imap.xml
// y mail-sender-pop3.xml siguen compartiendo exactamente esta clave — afecta solo al Mail Sender
// (recibir/hacer polling de correo hacia el iflow), no usado en ningun diseno de este proyecto
// hasta ahora; si hiciera falta, anadir tambien TransportProtocol a la clave.
const ADAPTER_COMPONENTS_DIR = path.join(__dirname, 'ai-iflow-components')
function buildAdapterReferenceIndex() {
  const index = {}
  if (!fs.existsSync(ADAPTER_COMPONENTS_DIR)) return index
  for (const file of fs.readdirSync(ADAPTER_COMPONENTS_DIR)) {
    if (!file.endsWith('.xml')) continue
    const content = fs.readFileSync(path.join(ADAPTER_COMPONENTS_DIR, file), 'utf8')
    const flowMatch = content.match(/<bpmn2:messageFlow[\s\S]*?<\/bpmn2:messageFlow>/)
    if (!flowMatch) continue
    const componentType = (flowMatch[0].match(/<key>ComponentType<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
    const messageProtocol = (flowMatch[0].match(/<key>MessageProtocol<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
    const direction = (flowMatch[0].match(/<key>direction<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
    if (!componentType) continue
    const key = `${componentType}::${messageProtocol || ''}::${direction || ''}`
    const props = {}
    const propRe = /<key>([^<]+)<\/key>\s*<value>([^<]*)<\/value>/g
    let pm
    while ((pm = propRe.exec(flowMatch[0]))) if (pm[2]) props[pm[1]] = pm[2]
    index[key] = props
  }
  return index
}
const ADAPTER_REFERENCE_INDEX = buildAdapterReferenceIndex()

// Red de seguridad general: la IA ha demostrado (en varias generaciones reales del mismo
// diseno) omitir de forma inconsistente distintas properties de un messageFlow entre una tirada
// y otra — a veces falta solo "Name", otras veces faltan tambien "server"/"address"/"operation"/
// "system"/etc., causando distintos NullPointerException al abrir el iflow en el editor
// ("Name is null", "getServer() is null", y potencialmente otros no vistos aun). En vez de ir
// parcheando propiedad a propiedad cada vez que aparece una nueva, esto compara cada messageFlow
// generado contra SU MISMO componente de referencia (por cname del cmdVariantUri) y rellena
// cualquier property presente en la referencia pero ausente en el generado, con el valor real ya
// verificado en la libreria — evidentemente un placeholder de plantilla en muchos casos (URLs,
// nombres de sistema), pero nunca nulo.
function repairIncompleteAdapterProperties(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:messageFlow\s+([^>]*?)>([\s\S]*?)<\/bpmn2:messageFlow>/g,
    (full, openAttrs, body) => {
      const componentType = (body.match(/<key>ComponentType<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
      const messageProtocol = (body.match(/<key>MessageProtocol<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
      const direction = (body.match(/<key>direction<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
      const refProps = componentType && ADAPTER_REFERENCE_INDEX[`${componentType}::${messageProtocol || ''}::${direction || ''}`]
      if (!refProps) return full

      const missingProps = Object.entries(refProps)
        .filter(([key]) => !new RegExp(`<key>${key}</key>`).test(body))
        .map(([key, value]) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`)
      if (!missingProps.length) return full

      const newBody = body.replace('<bpmn2:extensionElements>', `<bpmn2:extensionElements>${missingProps.join('')}`)
      return `<bpmn2:messageFlow ${openAttrs}>${newBody}</bpmn2:messageFlow>`
    }
  )
}

// Mismo problema que repairIncompleteAdapterProperties pero para pasos de flujo (callActivity/
// serviceTask: Data Store, Content Modifier, Groovy Script, Router...) en vez de adaptadores —
// verificado con un diseno real donde los dos pasos Data Store Write/Get se quedaron sin "alert"
// ni "expire", fallando el build con "'Retention Threshold for Alerting' cannot be empty" /
// "'Expiration Period' cannot be empty". Indexado por "cname" del cmdVariantUri (no por
// ComponentType/MessageProtocol/direction como los adaptadores): estos componentes no tienen esas
// tres properties, y cname si es unico entre ellos salvo un caso (content-modifier.xml y
// content-enricher-lookup.xml comparten cname "Enricher" porque son el mismo componente con dos
// ejemplos de configuracion distintos — no es una colision real, cualquiera de los dos sirve
// igual de bien para rellenar las properties estandar que le faltan a un Content Modifier).
function buildFlowStepReferenceIndex() {
  const index = {}
  if (!fs.existsSync(ADAPTER_COMPONENTS_DIR)) return index
  for (const file of fs.readdirSync(ADAPTER_COMPONENTS_DIR)) {
    if (!file.endsWith('.xml')) continue
    const content = fs.readFileSync(path.join(ADAPTER_COMPONENTS_DIR, file), 'utf8')
    if (/<bpmn2:messageFlow/.test(content)) continue // esos van en ADAPTER_REFERENCE_INDEX
    const stepMatch = content.match(/<bpmn2:(?:callActivity|serviceTask)[\s\S]*?<\/bpmn2:(?:callActivity|serviceTask)>/)
    if (!stepMatch) continue
    const cmdVariantUri = (stepMatch[0].match(/<key>cmdVariantUri<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
    const cnameMatch = cmdVariantUri && cmdVariantUri.match(/cname::([^/]+)/)
    if (!cnameMatch) continue
    const props = {}
    const propRe = /<key>([^<]+)<\/key>\s*<value>([^<]*)<\/value>/g
    let pm
    while ((pm = propRe.exec(stepMatch[0]))) if (pm[2]) props[pm[1]] = pm[2]
    index[cnameMatch[1]] = props
  }
  return index
}
const FLOW_STEP_REFERENCE_INDEX = buildFlowStepReferenceIndex()

function repairIncompleteFlowStepProperties(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:(callActivity|serviceTask)\s+([^>]*?)>([\s\S]*?)<\/bpmn2:\1>/g,
    (full, tag, openAttrs, body) => {
      const cmdVariantUri = (body.match(/<key>cmdVariantUri<\/key>\s*<value>([^<]*)<\/value>/) || [])[1]
      const cnameMatch = cmdVariantUri && cmdVariantUri.match(/cname::([^/]+)/)
      const refProps = cnameMatch && FLOW_STEP_REFERENCE_INDEX[cnameMatch[1]]
      if (!refProps) return full

      const missingProps = Object.entries(refProps)
        .filter(([key]) => !new RegExp(`<key>${key}</key>`).test(body))
        .map(([key, value]) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`)
      if (!missingProps.length) return full

      const newBody = body.replace('<bpmn2:extensionElements>', `<bpmn2:extensionElements>${missingProps.join('')}`)
      return `<bpmn2:${tag} ${openAttrs}>${newBody}</bpmn2:${tag}>`
    }
  )
}

// SAP no admite espacios NI puntos en el "name" de un participante Sender/Receiver — verificado
// con un diseno real ("Https GeoVictoria", "SFSF Test", "URL_MAIL (smtp.office365.com)") que
// fallaba en el build con "Whitespace not allowed in Receiver name" y, tras quitar solo los
// espacios en un primer intento, con "Receiver name should not contain ." (el nombre del Mail
// aun tenia "smtp.office365.com" dentro). Se sustituye cualquier caracter que no sea letra,
// numero o "_" por "_" (colapsando repeticiones), no solo los espacios.
function repairParticipantNameWhitespace(iflwContent) {
  return iflwContent.replace(/<bpmn2:participant\s+([^>]*?)>/g, (full, attrs) => {
    const type = getAttr(attrs, 'ifl:type')
    if (type !== 'EndpointRecevier' && type !== 'EndpointSender') return full
    const name = getAttr(attrs, 'name')
    if (!name) return full
    const sanitized = name.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '')
    if (sanitized === name) return full
    const newAttrs = attrs.replace(/\bname="[^"]*"/, `name="${sanitized}"`)
    return `<bpmn2:participant ${newAttrs}>`
  })
}

// SAP no admite que dos interfaces (messageFlow) que apuntan al MISMO Receiver compartan el
// mismo nombre de canal (name=) NI el mismo alias de conexion (property "system") — verificado
// con un diseno real donde 3 llamadas a "SFSF Test" se llamaban las 3 "SuccessFactors" con
// system="Receiver9" (la IA usa el ComponentType/un ejemplo generico para ambos, sin
// diferenciarlas), fallando el build con "Same channel name cannot be specified for a system
// having multiple interfaces" repetido. El propio repairIncompleteAdapterProperties puede
// CAUSAR esta segunda colision (rellena "system" con el mismo valor de ejemplo de la referencia
// en cada copia) — por eso esta funcion debe correr DESPUES de esa, no antes. Se numeran solo
// las que realmente colisionan (mismo targetRef + mismo valor), dejando intacto el resto.
function repairDuplicateChannelNames(iflwContent) {
  let result = iflwContent
  result = dedupeMessageFlowAttr(result, 'name', (attrs) => getAttr(attrs, 'name'),
    (attrs, newVal) => attrs.replace(/\bname="[^"]*"/, `name="${newVal}"`))
  result = dedupeMessageFlowProperty(result, 'system')
  return result
}

function collectMessageFlowGroups(iflwContent, getValue) {
  const flows = []
  const tagRe = /<bpmn2:messageFlow\s+([^>]*?)>/g
  let m
  while ((m = tagRe.exec(iflwContent))) {
    const id = getAttr(m[1], 'id')
    const target = getAttr(m[1], 'targetRef')
    const value = getValue(m[1])
    if (id && value) flows.push({ id, target, value })
  }
  const groups = {}
  for (const f of flows) {
    const key = `${f.target}::${f.value}`
    ;(groups[key] = groups[key] || []).push(f)
  }
  const renameMap = {}
  for (const key of Object.keys(groups)) {
    const group = groups[key]
    if (group.length < 2) continue
    group.forEach((f, i) => { renameMap[f.id] = `${f.value}_${i + 1}` })
  }
  return renameMap
}

function dedupeMessageFlowAttr(iflwContent, attrName, getValue, setValue) {
  const renameMap = collectMessageFlowGroups(iflwContent, getValue)
  if (!Object.keys(renameMap).length) return iflwContent
  return iflwContent.replace(/<bpmn2:messageFlow\s+([^>]*?)>/g, (full, attrs) => {
    const id = getAttr(attrs, 'id')
    if (!renameMap[id]) return full
    return `<bpmn2:messageFlow ${setValue(attrs, renameMap[id])}>`
  })
}

function dedupeMessageFlowProperty(iflwContent, key) {
  const propRe = new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`)
  // El valor de una property (a diferencia de un atributo XML) no esta en la etiqueta de
  // apertura sino en el cuerpo del messageFlow, asi que hace falta el bloque completo, no solo attrs.
  const flows = []
  const blockRe = /<bpmn2:messageFlow\s+([^>]*?)>([\s\S]*?)<\/bpmn2:messageFlow>/g
  let m
  while ((m = blockRe.exec(iflwContent))) {
    const id = getAttr(m[1], 'id')
    const target = getAttr(m[1], 'targetRef')
    const valMatch = propRe.exec(m[2])
    if (id && valMatch) flows.push({ id, target, value: valMatch[1] })
  }
  const groups = {}
  for (const f of flows) {
    const gkey = `${f.target}::${f.value}`
    ;(groups[gkey] = groups[gkey] || []).push(f)
  }
  const newValueMap = {}
  for (const gkey of Object.keys(groups)) {
    const group = groups[gkey]
    if (group.length < 2) continue
    group.forEach((f, i) => { newValueMap[f.id] = `${f.value}_${i + 1}` })
  }
  if (!Object.keys(newValueMap).length) return iflwContent

  return iflwContent.replace(blockRe, (full, attrs, body) => {
    const id = getAttr(attrs, 'id')
    if (!newValueMap[id]) return full
    const newBody = body.replace(propRe, `<key>${key}</key><value>${newValueMap[id]}</value>`)
    return `<bpmn2:messageFlow ${attrs}>${newBody}</bpmn2:messageFlow>`
  })
}

// El adaptador Mail necesita SIEMPRE la property "server" (host SMTP) — verificado con un
// diseno real donde Gemini genero un messageFlow ComponentType=Mail sin ella (junto con
// from/subject/body, tambien omitidas esa tirada), y el editor grafico fallaba al validar con
// "NullPointerException: Cannot invoke String.split(String) because the return value of
// ConnectionDetails.getServer() is null" (validador propio de SAP,
// com.sap.it.gnb.ifl.mail.validator). A diferencia de "Name" (repairMissingAdapterNames), aqui
// no hay un valor real derivable de otra parte del propio messageFlow, asi que se rellena con un
// placeholder obviamente falso ("smtp.example.com") — evita el crash y dice claramente que hay
// que configurar el servidor real, en vez de inventar un host que parezca valido.
function repairMissingMailServer(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:messageFlow\s+([^>]*?)>([\s\S]*?)<\/bpmn2:messageFlow>/g,
    (full, openAttrs, body) => {
      if (!/<key>ComponentType<\/key>\s*<value>Mail<\/value>/.test(body)) return full
      if (/<key>server<\/key>\s*<value>[^<]+<\/value>/.test(body)) return full
      const newProp = `<ifl:property><key>server</key><value>smtp.example.com</value></ifl:property>`
      const newBody = body.replace('<bpmn2:extensionElements>', `<bpmn2:extensionElements>${newProp}`)
      return `<bpmn2:messageFlow ${openAttrs}>${newBody}</bpmn2:messageFlow>`
    }
  )
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
// > Crear's write path. Sender and/or Receiver in the POST body 500 with an
// empty error message (verified against a real tenant, isolated field by
// field — Description alone is fine, Sender alone and Receiver alone both
// fail) despite the API's own documented request shape listing them as
// valid create-time fields. Both DO work on an immediate follow-up PUT
// (also verified), so create with the minimal body, then reuse
// uploadIflowZip right after to set Description/Sender/Receiver.
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
  repairMissingDiagramEdges,
  repairMissingAdapterNames,
  repairMissingMailServer,
  repairIncompleteAdapterProperties,
  repairIncompleteFlowStepProperties,
  repairParticipantNameWhitespace,
  repairDuplicateChannelNames,
  buildIflowFromTemplate,
  uploadIflowZip,
  createIflowZip,
  deployArtifact
}
