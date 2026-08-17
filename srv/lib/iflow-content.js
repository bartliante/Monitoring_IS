// Everything about treating an iflow as a downloadable/uploadable ZIP artifact,
// called directly against the Manage Integration Content API — same
// go-around-CQN approach as ErrorInformation/$value in monitor-service.js,
// since none of this (binary ZIP download/upload, deploy trigger) is
// expressible as a CQN SELECT.

const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { SaxesParser } = require('saxes')
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

  // El .iflw se procesa SIEMPRE primero e ignora el tope de tamaño — verificado con un diseno
  // real ("completo", ya en 113-118KB solo el .iflw) que el orden de entrada del ZIP no
  // garantiza que el .iflw se recorra antes que los scripts/parametros: si estos se procesaban
  // antes y agotaban el presupuesto de MAX_TOTAL_BYTES, el .iflw se descartaba SILENCIOSAMENTE
  // (ni error ni aviso), dejando flowXml vacio — usado tanto para el contexto que ve la IA en
  // "Actualizar" como para el diagrama que pinta la propia app, asi que su ausencia se notaba
  // como "no aparece el grafico del iflow en la aplicacion" sin ninguna pista de por que. El
  // .iflw es un unico fichero y el mas importante de los tres grupos — nunca debe ser el que se
  // sacrifique por el tope pensado para acotar cuantos scripts/parametros se envian a la IA.
  const entries = zip.getEntries()
  const flowEntry = entries.find(e => !e.isDirectory && /\.iflw$/.test(e.entryName) && RELEVANT_PATH_PATTERNS[0].test(e.entryName))
  if (flowEntry) {
    const content = flowEntry.getData().toString('utf8')
    flowXml.push({ path: flowEntry.entryName, content })
    totalBytes += content.length
  }

  for (const entry of entries) {
    if (entry.isDirectory || entry === flowEntry) continue
    const path = entry.entryName
    const isScript = RELEVANT_PATH_PATTERNS[1].test(path) || RELEVANT_PATH_PATTERNS[2].test(path)
    const isParameters = PARAMETERS_PATHS.includes(path)
    if (!isScript && !isParameters) continue

    const content = entry.getData().toString('utf8')
    if (totalBytes + content.length > MAX_TOTAL_BYTES) continue
    totalBytes += content.length

    if (isScript) scripts.push({ path, content })
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

// La IA a veces omite la etiqueta de cierre "</ifl:property>" al escribir una property cuyo
// "value" es un texto largo con comillas anidadas (visto especificamente con "wrapContent"
// conteniendo un JSON literal tipo {"campo": "${property.x}", ...}) — probablemente pierde la
// cuenta de las etiquetas al generar una cadena tan cargada de comillas escapadas. El resultado
// es un XML MAL FORMADO (no un simple error de validacion de negocio como el resto de repairs de
// este fichero): el editor grafico ni siquiera consigue ABRIR el iflow ("no me abre el iflow"),
// a diferencia de "Name is null" que si abre pero falla la validacion. Verificado con un diseno
// real: dos "wrapContent" identicos en forma (JSON con varios "${property.X}") se generaron sin
// su "</ifl:property>", dejando 2 "unexpected close tag" al parsear el .iflw completo. Se
// detecta cualquier "<ifl:property>...<key>...<value>...</value>" que NO vaya seguido de su
// cierre y se le anade — debe correr ANTES que el resto de repairs de este fichero, ya que estos
// asumen properties bien formadas al buscar "ya existe esta key?" con regex.
function repairUnclosedPropertyTags(iflwContent) {
  return iflwContent.replace(
    /<ifl:property>\s*<key>[^<]*<\/key>\s*(?:<value\s*\/>|<value>[\s\S]*?<\/value>)(?!\s*<\/ifl:property>)/g,
    match => `${match}</ifl:property>`
  )
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
    // <value/> autocerrado ademas de <value>texto</value>, e incluir TAMBIEN las keys con valor
    // vacio (no solo las truthy): mismo fallo ya corregido en buildIFlowConfigReference — un
    // adaptador de referencia real (Mail) trae ~15 properties intencionalmente vacias por defecto
    // (to, subject, from, server, bcc...) que el regex anterior no reconocia en absoluto, dejando
    // esas keys COMPLETAMENTE AUSENTES del generado en vez de presentes-pero-vacias. La ausencia
    // total (no solo el valor vacio) ya se ha visto causando "NullPointerException: Name is null"
    // al abrir el iflow (el editor no encuentra el elemento del que sacar la etiqueta visible del
    // campo) — no solo en el bloque de "Integration Flow Configuration" sino tambien aqui, en
    // adaptadores.
    const propRe = /<key>([^<]+)<\/key>\s*(?:<value\s*\/>|<value>([^<]*)<\/value>)/g
    let pm
    while ((pm = propRe.exec(flowMatch[0]))) props[pm[1]] = pm[2] || ''
    index[key] = props
    // Indice de respaldo, mas laxo (solo ComponentType::direction, "primero gana"): hace falta
    // porque a veces la IA omite el propio MessageProtocol (no solo otras properties), y sin el
    // no hay forma de construir la clave exacta de arriba — verificado con un diseno real donde
    // varios messageFlow (HTTP, SuccessFactors, Mail) se quedaban con solo 8 properties genericas
    // sin reparar porque MessageProtocol faltaba del todo, mientras que otros del mismo diseno
    // con MessageProtocol presente si se reparaban bien. Ambiguo si hay variantes distintas del
    // mismo ComponentType+direction (p.ej. SuccessFactors OData vs SOAP) — para esos casos el
    // resultado puede no ser el correcto, pero sigue siendo mejor que dejar el adaptador a medias
    // con properties nulas.
    const looseKey = `${componentType}::${direction || ''}`
    if (!(looseKey in ADAPTER_REFERENCE_LOOSE_INDEX)) ADAPTER_REFERENCE_LOOSE_INDEX[looseKey] = props
    // Indice de respaldo AUN mas laxo (solo ComponentType, "primero gana"): verificado con un
    // diseno real (Mail) donde la IA genero un messageFlow con SOLO 8 properties genericas,
    // faltando MessageProtocol Y direction A LA VEZ desde el principio — ni la clave estricta
    // (ComponentType::MessageProtocol::direction) ni la laxa de arriba (ComponentType::direction)
    // pueden construirse sin esos mismos valores que faltan (problema de "huevo y gallina": las
    // properties que hacen falta para ENCONTRAR la referencia son justo las que faltan en el
    // generado). Sin este ultimo nivel, el backfill se queda mudo y el adaptador se despliega con
    // un tercio de sus properties reales, causando "NullPointerException: Name is null" al abrir
    // el iflow en el editor grafico — verificado en un diseno real (Mail Receiver, ComponentType
    // sin MessageProtocol/direction). Igual de ambiguo que el resto de indices laxos si hay varias
    // variantes del mismo ComponentType en la libreria (aqui no es el caso de Mail: solo hay un
    // mail-receiver.xml — el ambiguo, mail-sender-imap.xml/mail-sender-pop3.xml, es Sender, no
    // Receiver, y no comparte ComponentType con el caso de "enviar" que motiva este fallback).
    if (!(componentType in ADAPTER_REFERENCE_COMPONENT_TYPE_INDEX)) ADAPTER_REFERENCE_COMPONENT_TYPE_INDEX[componentType] = props
  }
  return index
}
const ADAPTER_REFERENCE_LOOSE_INDEX = {}
const ADAPTER_REFERENCE_COMPONENT_TYPE_INDEX = {}
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
      const refProps = componentType && (
        ADAPTER_REFERENCE_INDEX[`${componentType}::${messageProtocol || ''}::${direction || ''}`] ||
        ADAPTER_REFERENCE_LOOSE_INDEX[`${componentType}::${direction || ''}`] ||
        ADAPTER_REFERENCE_COMPONENT_TYPE_INDEX[componentType]
      )
      if (!refProps) return full

      // Comprobacion "ya existe?" insensible a mayusculas/minusculas: verificado con un diseno
      // real donde la IA genero "serverTrace" (minuscula, en el bloque de "Integration Flow
      // Configuration") y una version sensible a mayusculas de este mismo filtro, al comparar
      // contra "ServerTrace" (grafia real de la referencia), no la reconocio como la misma y
      // anadio una SEGUNDA property duplicada solo por el casing — causando
      // "NullPointerException: Name is null" al abrir el iflow. Aplica igual aqui por si algun
      // adaptador tiene el mismo problema de casing en alguna de sus properties.
      const missingProps = Object.entries(refProps)
        .filter(([key]) => !new RegExp(`<key>${key}</key>`, 'i').test(body))
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
    // <value/> autocerrado incluido, mismo fallo que en buildAdapterReferenceIndex/
    // buildIFlowConfigReference: una key con valor vacio por defecto quedaba totalmente ausente.
    const propRe = /<key>([^<]+)<\/key>\s*(?:<value\s*\/>|<value>([^<]*)<\/value>)/g
    let pm
    while ((pm = propRe.exec(stepMatch[0]))) props[pm[1]] = pm[2] || ''
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
        .filter(([key]) => !new RegExp(`<key>${key}</key>`, 'i').test(body))
        .map(([key, value]) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`)
      if (!missingProps.length) return full

      const newBody = body.replace('<bpmn2:extensionElements>', `<bpmn2:extensionElements>${missingProps.join('')}`)
      return `<bpmn2:${tag} ${openAttrs}>${newBody}</bpmn2:${tag}>`
    }
  )
}

// Para escribir (upsert) en SuccessFactors, el valor valido de "Operation Details" es
// "Upsert(UPSERT)" — confirmado registrandolo a mano en el editor grafico real y descargando el
// .iflw resultante para verificarlo (varios intentos previos con "Upsert(PUT)"/"Upsert(POST)"/
// "Upsert (POST)"/"Upsert" a secas fallaron todos: a diferencia de "Query(GET)", donde el
// sufijo es el verbo HTTP, aqui el sufijo es el propio nombre de la operacion OData en
// mayusculas, no un verbo HTTP). La IA (y el propio componente de referencia
// successfactors-odata-receiver.xml, que solo trae un ejemplo de lectura "Query(GET)") genera
// "Upsert(PUT)" para el paso de actualizar el monitor de replica, que SAP rechaza.
function repairSuccessFactorsUpsertOperation(iflwContent) {
  return iflwContent.replace(/<key>operation<\/key>\s*<value>Upsert[^<]*<\/value>/g, '<key>operation</key><value>Upsert(UPSERT)</value>')
}

// El unico valor de "Authentication" verificado como valido para el adaptador SuccessFactors en
// este tenant es "Basic" (el que trae el propio componente de referencia
// successfactors-odata-receiver.xml) — verificado con un diseno real donde la IA genero
// "OAuth2SAMLBearerAssertion" para una llamada de consulta (Query), fallando el build con
// "Invalid value 'OAuth2SAMLBearerAssertion' entered in 'Authentication' field". Se corrige
// cualquier authenticationMethod de un messageFlow SuccessFactors que NO sea "Basic".
function repairSuccessFactorsAuthMethod(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:messageFlow\s+[^>]*?>[\s\S]*?<\/bpmn2:messageFlow>/g,
    block => {
      if (!/<key>ComponentType<\/key>\s*<value>SuccessFactors<\/value>/.test(block)) return block
      return block.replace(/<key>authenticationMethod<\/key>\s*<value>(?!Basic<)[^<]*<\/value>/, '<key>authenticationMethod</key><value>Basic</value>')
    }
  )
}

// SuccessFactors con paginacion server-side ("paging: snapshot") necesita "HTTP Session Reuse"
// activado a nivel de IFLOW (seccion "Runtime Configuration" del editor grafico, NO una property
// del propio adaptador) o SAP rechaza el build con "You need to enable HTTP session reuse for
// SuccessFactors server side paging" — confirmado activandolo a mano en el editor real y
// comparando el .iflw resultante: la property de colaboracion "httpSessionHandling" pasa de
// "None" a "onExchange".
function repairSuccessFactorsSessionReuse(iflwContent) {
  // Antes se comprobaba con un solo regex "ComponentType...paging" a distancia <2000 caracteres
  // del documento ENTERO, asumiendo que ComponentType aparece siempre ANTES que paging dentro del
  // messageFlow — verificado con un diseno real que el orden de las properties generadas por la
  // IA no es fijo (paging aparecio ANTES que ComponentType), haciendo que el regex nunca
  // matcheara pese a haber 3 adaptadores SuccessFactors con paging=snapshot, dejando
  // "httpSessionHandling" en "None" sin avisar. Se comprueba ahora messageFlow por messageFlow
  // (mismo patron que el resto de repairs de este fichero), sin depender del orden interno.
  const usesPagingSFSF = [...iflwContent.matchAll(/<bpmn2:messageFlow[^>]*>[\s\S]*?<\/bpmn2:messageFlow>/g)]
    .some(m => /<key>ComponentType<\/key>\s*<value>SuccessFactors<\/value>/.test(m[0]) && /<key>paging<\/key>\s*<value>snapshot<\/value>/.test(m[0]))
  if (!usesPagingSFSF) return iflwContent
  if (/<key>httpSessionHandling<\/key>\s*<value>onExchange<\/value>/.test(iflwContent)) return iflwContent
  return iflwContent.replace(
    /<key>httpSessionHandling<\/key>\s*<value>[^<]*<\/value>/,
    '<key>httpSessionHandling</key><value>onExchange</value>'
  )
}

// Referencia de las properties completas del bloque "Integration Flow Configuration" (a nivel
// de bpmn2:collaboration), leidas de la propia plantilla vacia base — esa SI esta completa y
// verificada (es el punto de partida de cualquier iflow de este proyecto).
function buildIFlowConfigReference() {
  if (!fs.existsSync(TEMPLATE_PATH)) return {}
  const zip = new AdmZip(fs.readFileSync(TEMPLATE_PATH))
  const flowDir = 'src/main/resources/scenarioflows/integrationflow/'
  const flowEntry = zip.getEntries().find(e => e.entryName.startsWith(flowDir) && e.entryName.endsWith('.iflw'))
  if (!flowEntry) return {}
  const content = flowEntry.getData().toString('utf8')
  const collabMatch = content.match(/<bpmn2:collaboration[^>]*>[\s\S]*?<bpmn2:extensionElements>([\s\S]*?)<\/bpmn2:extensionElements>/)
  if (!collabMatch) return {}
  const props = {}
  // <value/> autocerrado, ademas de <value>texto</value>: la plantilla base deja varias
  // properties OPCIONALES sin valor por defecto (privateKeyAlias, traceLevel, namespaceMapping,
  // errorStrategy, allowedHeaderList) como <value/> autocerrado — el regex anterior solo
  // reconocia la forma <value>texto</value>, asi que ni siquiera llegaba a intentar matchear
  // estas 5 keys, dejandolas FUERA de la referencia por completo (no solo con valor vacio).
  // Verificado que su AUSENCIA total (no solo el valor vacio) en un iflow generado era una causa
  // mas, no detectada hasta ahora, del mismo "NullPointerException: Name is null" en el editor
  // grafico — el screen "Integration Flow Configuration" itera sobre las 12 keys que conoce y
  // falla al construir el formulario si el elemento no existe en absoluto para alguna, no solo si
  // su valor esta vacio.
  const propRe = /<key>([^<]+)<\/key>\s*(?:<value\s*\/>|<value>([^<]*)<\/value>)/g
  let pm
  while ((pm = propRe.exec(collabMatch[1]))) props[pm[1]] = pm[2] || ''
  return props
}
const IFLOW_CONFIG_REFERENCE = buildIFlowConfigReference()

// Red de seguridad para "Integration Flow Configuration" (el bloque de properties a nivel de
// bpmn2:collaboration, section "Runtime Configuration" del editor) — mismo problema ya visto en
// adaptadores y pasos de flujo, esta vez a nivel global del iflow: verificado con un diseno real
// donde la IA dejo el bloque con solo 3 properties (cmdVariantUri/componentVersion/
// httpSessionHandling) en vez de las ~10 que trae la plantilla base, causando
// "NullPointerException: Name is null" localizado por el propio editor en "Integration Flow
// Configuration" al abrir el iflow. Rellena cualquier property presente en la plantilla base
// pero ausente en el generado (nunca pisa las que la IA SI puso, como httpSessionHandling si ya
// esta en "onExchange" por repairSuccessFactorsSessionReuse).
// La IA puede generar la MISMA property dos veces con distinto casing dentro del mismo bloque
// (p.ej. "serverTrace" Y "ServerTrace" a la vez) — verificado con un diseno real que causaba
// "NullPointerException: Name is null" al abrir el iflow. Se queda con la PRIMERA aparicion de
// cada clave (case-insensitive) y descarta el resto.
function dedupeCaseVariantProperties(body) {
  const seen = new Set()
  return body.replace(/<ifl:property>\s*<key>([^<]+)<\/key>[\s\S]*?<\/ifl:property>\s*/g, (full, key) => {
    const lower = key.toLowerCase()
    if (seen.has(lower)) return ''
    seen.add(lower)
    return full
  })
}

// "ServerTrace" es la UNICA key de todo este bloque que no empieza en minuscula (todas las
// demas siguen camelCase normal: cmdVariantUri, componentVersion, httpSessionHandling,
// corsEnabled...) — verificado que la IA la "normaliza" sistematicamente a "serverTrace" para
// seguir el patron del resto, sin que esto rompa el build (SAP no lo valida ahi) pero SI rompe
// el editor grafico: la key con casing incorrecto no se reconoce en el lookup interno de SAP
// (case-sensitive) al construir la pantalla "Integration Flow Configuration", devolviendo
// "NullPointerException: Name is null" al no encontrar la etiqueta visible de esa property. La
// comprobacion "ya existe?" de repairIncompleteIFlowConfiguration es deliberadamente
// case-insensitive (evita anadir una SEGUNDA copia con casing distinto), pero por eso mismo NUNCA
// corregia el casing incorrecto si ya habia una unica copia mal escrita — se soluciona aqui
// reescribiendo cualquier variante de casing a la key exacta de la referencia ANTES del dedupe
// (para que, si la IA llegara a generar ambas grafias a la vez, el dedupe posterior las trate
// como una autentica duplicada y se quede con una sola).
function normalizeReferenceKeyCasing(body) {
  for (const canonicalKey of Object.keys(IFLOW_CONFIG_REFERENCE)) {
    const re = new RegExp(`<key>${canonicalKey}</key>`, 'ig')
    body = body.replace(re, `<key>${canonicalKey}</key>`)
  }
  return body
}

function repairIncompleteIFlowConfiguration(iflwContent) {
  const collabMatch = iflwContent.match(/<bpmn2:collaboration[^>]*>[\s\S]*?<bpmn2:extensionElements>([\s\S]*?)<\/bpmn2:extensionElements>/)
  if (!collabMatch) return iflwContent
  let body = collabMatch[1]
  const normalizedBody = normalizeReferenceKeyCasing(body)
  const dedupedBody = dedupeCaseVariantProperties(normalizedBody)
  if (dedupedBody !== body) {
    const idx0 = iflwContent.indexOf(body)
    if (idx0 !== -1) iflwContent = iflwContent.slice(0, idx0) + dedupedBody + iflwContent.slice(idx0 + body.length)
    body = dedupedBody
  }
  const missingProps = Object.entries(IFLOW_CONFIG_REFERENCE)
    .filter(([key]) => !new RegExp(`<key>${key}</key>`, 'i').test(body))
    .map(([key, value]) => `<ifl:property><key>${key}</key><value>${value}</value></ifl:property>`)
  if (!missingProps.length) return iflwContent
  const newBody = body + missingProps.join('')
  // indexOf/slice en vez de .replace(body, ...): body puede contener "$" y String.replace
  // interpreta patrones especiales ($&, $$...) en el segundo argumento si se usa como string.
  const idx = iflwContent.indexOf(body)
  if (idx === -1) return iflwContent
  return iflwContent.slice(0, idx) + newBody + iflwContent.slice(idx + body.length)
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

// Mismo problema que repairParticipantNameWhitespace, pero para la property "Name" DENTRO del
// propio messageFlow — es un campo DISTINTO del atributo name= del messageFlow (ese ya lo
// deduplica repairDuplicateChannelNames) y del name= del participante: esta es la etiqueta que
// SAP muestra literalmente como "Name" en el panel de configuracion del adaptador Sender/Receiver
// (el mismo concepto de "nombre de conexion" que ya rechazaba espacios en el participante).
// Verificado con un diseno real donde el atributo name= del messageFlow ya estaba deduplicado y
// limpio ("SuccessFactors_1", "HTTP_1"...) pero la property interna seguia con el valor original
// de la IA sin sanear ("SuccessFactors Monitor", "HTTP Login", "HTTP TimeOff Alta"...). Mismo
// criterio de saneo (cualquier caracter que no sea letra/numero/"_" pasa a "_").
function repairAdapterNamePropertyWhitespace(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:messageFlow\s+[^>]*>[\s\S]*?<\/bpmn2:messageFlow>/g,
    block => block.replace(/<key>Name<\/key>\s*<value>([^<]*)<\/value>/, (full, name) => {
      const sanitized = name.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '')
      if (sanitized === name) return full
      return `<key>Name</key><value>${sanitized}</value>`
    })
  )
}

// SAP no admite que dos interfaces (messageFlow) que apuntan al MISMO Receiver compartan el
// mismo nombre de canal (name=) NI el mismo alias de conexion (property "system") NI la misma
// etiqueta visible (property "Name", la que se ve en el panel de configuracion del adaptador) —
// verificado con dos disenos reales: uno donde 3 llamadas a "SFSF Test" se llamaban las 3
// "SuccessFactors" con system="Receiver9" (la IA usa el ComponentType/un ejemplo generico para
// ambos, sin diferenciarlas), y otro DISTINTO donde name= y system YA estaban bien
// deduplicados (SuccessFactors_1/2/3, Receiver9_1/2/3) pero la property "Name" seguia repetida
// tal cual ("SuccessFactors" x3, "HTTP" x4, "Mail" x2) porque nunca se cubria — ambos fallan con
// el mismo "Same channel name cannot be specified for a system having multiple interfaces". El
// propio repairIncompleteAdapterProperties puede CAUSAR estas colisiones (rellena "system"/"Name"
// con el mismo valor de ejemplo de la referencia en cada copia) — por eso esta funcion debe correr
// DESPUES de esa, no antes. Se numeran solo las que realmente colisionan (mismo targetRef + mismo
// valor), dejando intacto el resto.
function repairDuplicateChannelNames(iflwContent) {
  let result = iflwContent
  result = dedupeMessageFlowAttr(result, 'name', (attrs) => getAttr(attrs, 'name'),
    (attrs, newVal) => attrs.replace(/\bname="[^"]*"/, `name="${newVal}"`))
  result = dedupeMessageFlowProperty(result, 'system')
  result = dedupeMessageFlowProperty(result, 'Name')
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
  const propRe = new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`, 'i')
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

// A veces la IA declara un parametro externalizado (parameters.propdef + parameters.prop) pero
// se olvida de referenciarlo realmente en el propio .iflw con la sintaxis "{{nombre}}" en alguna
// property de un paso — el parametro queda "huerfano": declarado pero sin ningun sitio del flujo
// que lo use. Verificado con un diseno real ("completo"): parameters.propdef declaraba
// "person_id_external" (con su entrada correspondiente, vacia, en parameters.prop) pero el .iflw
// no lo referenciaba en ningun punto ("{{person_id_external}}" no aparecia en absoluto), mientras
// que "timerSchedule" si estaba bien enlazado. La pantalla "Integration Flow Configuration" del
// editor grafico (la que construye el formulario para rellenar cada parametro externalizado)
// fallaba con "NullPointerException: Name is null" precisamente al intentar construir el campo
// de ese parametro huerfano — no hay ningun property enlazado en el flujo del que sacar su
// nombre/etiqueta visible. Se eliminan del propdef/prop los parametros declarados que no aparecen
// referenciados en el .iflw — mas seguro que intentar adivinar donde deberia haberse usado.
// A diferencia del resto de funciones "repair*" de este fichero, esta opera sobre la lista
// completa de ficheros (necesita ver el .iflw Y el propdef/prop a la vez), no sobre un solo
// contenido de string.
function repairOrphanedExternalizedParameters(files) {
  const flowFile = files.find(f => f.path.endsWith('.iflw'))
  if (!flowFile) return files
  const usedParams = new Set([...flowFile.content.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]))

  return files.map(f => {
    if (f.path.endsWith('parameters.propdef')) {
      const newContent = f.content.replace(/<parameter>[\s\S]*?<\/parameter>\s*/g, block => {
        const nameMatch = block.match(/<name>([^<]*)<\/name>/)
        if (!nameMatch || usedParams.has(nameMatch[1])) return block
        return ''
      })
      return newContent === f.content ? f : { ...f, content: newContent }
    }
    if (f.path.endsWith('parameters.prop')) {
      const newContent = f.content.split('\n').filter(line => {
        const m = line.match(/^([^#=]+)=/)
        return !m || usedParams.has(m[1].trim())
      }).join('\n')
      return newContent === f.content ? f : { ...f, content: newContent }
    }
    return f
  })
}

// Cada exclusiveGateway ("Router") con mas de una salida necesita un atributo "default=" que
// apunte a UNA de sus propias sequenceFlow salientes (el campo "Default Route" del panel de
// configuracion real) — verificado con un diseno real ("completo"): 5 de sus 6 gateways generaron
// una salida "Default" sin conditionExpression + el atributo default= apuntando a ella, pero el
// sexto (logica de 3 ramas "alta / cancelacion / modificacion" forzada en un gateway binario) se
// quedo con AMBAS salidas condicionadas y sin default= en absoluto — inconsistente con el resto
// del mismo diseno. Sin esa referencia el editor grafico no tiene ninguna ruta de reserva que
// mostrar en "Default Route", encajando con el patron ya visto varias veces en este proyecto de
// "NullPointerException: Name is null" por una referencia esperada que no existe. No inventa una
// ruta nueva (seria adivinar la logica de negocio real) — solo marca como default la PRIMERA
// salida existente del propio gateway que aun no tuviera ya un default= asignado.
function repairMissingGatewayDefault(iflwContent) {
  const flowsBySource = {}
  const seqFlowRe = /<bpmn2:sequenceFlow\s+([^>]*?)(?:\/>|>)/g
  let m
  while ((m = seqFlowRe.exec(iflwContent))) {
    const id = getAttr(m[1], 'id')
    const source = getAttr(m[1], 'sourceRef')
    if (id && source) (flowsBySource[source] = flowsBySource[source] || []).push(id)
  }
  return iflwContent.replace(/<bpmn2:exclusiveGateway\s+([^>]*?)>/g, (full, attrs) => {
    if (getAttr(attrs, 'default')) return full
    const id = getAttr(attrs, 'id')
    const outgoing = id && flowsBySource[id]
    if (!outgoing || !outgoing.length) return full
    return `<bpmn2:exclusiveGateway ${attrs} default="${outgoing[0]}">`
  })
}

// El lenguaje de expresiones de condicion de un Router en SAP CPI usa "=" para igualdad, NO "=="
// (estilo Java/JS) — verificado con un diseno real donde la IA genero TODAS las condiciones de
// gateway como "${property.x} == 'true'", fallando el editor grafico con "Token '==' not
// supported after the token '${property.x}' in condition. Expected tokens: [=, !=, >, >=, <, <=,
// contains, not, in, regex]" para cada una. Se sustituye "==" por "=" SOLO dentro del texto de
// cada "bpmn2:conditionExpression" (no en todo el documento, para no tocar nada mas).
function repairConditionExpressionOperator(iflwContent) {
  return iflwContent.replace(
    /(<bpmn2:conditionExpression[^>]*>)([^<]*)(<\/bpmn2:conditionExpression>)/g,
    (full, open, text, close) => `${open}${text.replace(/==/g, '=')}${close}`
  )
}

// Una fila de "propertyTable"/"headerTable" (Content Modifier) con "Type"="xpath" (extraer un
// valor del mensaje de entrada, a diferencia de "constant") necesita SIEMPRE su celda "Datatype"
// rellena — a diferencia de "constant", donde SAP acepta "Datatype" vacio (asi lo trae el propio
// componente de referencia content-modifier.xml). Verificado con un diseno real: 5 filas type=xpath
// con Datatype vacio fallaban en el editor grafico con "Datatype not defined in row N of type
// xpath for Content Modifier step", una por cada fila. Se rellena con "String" — valor por
// defecto razonable para extraer texto via XPath; si algun caso necesitara Integer/Date en vez de
// String tendria que ajustarse a mano, pero es mejor un tipo generico presente que el campo vacio.
function repairXpathRowMissingDatatype(iflwContent) {
  return iflwContent.replace(
    /(<key>(?:propertyTable|headerTable)<\/key>\s*<value>)([^<]*)(<\/value>)/g,
    (full, open, tableText, close) => {
      const fixed = tableText.replace(
        /(&lt;row&gt;(?:(?!&lt;\/row&gt;)[\s\S])*?&lt;cell id='Type'&gt;xpath&lt;\/cell&gt;(?:(?!&lt;\/row&gt;)[\s\S])*?&lt;cell id='Datatype'&gt;)&lt;\/cell&gt;/g,
        `$1String&lt;/cell&gt;`
      )
      return `${open}${fixed}${close}`
    }
  )
}

// El campo real que SAP valida como obligatorio en un paso Data Store (Get/Put/Select/Delete,
// activityType=DBstorage) es "storageName" ("Data Store Name" en el editor) — presente en TODOS
// los componentes de referencia (get/put/select/delete). El paso "Get" ademas trae un SEGUNDO
// campo, "dataStoreId", que tambien esta vacio por defecto en la referencia. Verificado con un
// diseno real: la IA relleno "dataStoreId" con el nombre correcto del data store en el paso Get,
// pero dejo "storageName" vacio (el campo que SAP realmente exige), fallando el build con
// "'Data Store Name' cannot be empty" pese a que el paso Put del MISMO diseno si tenia
// "storageName" bien relleno. Si "storageName" esta vacio pero "dataStoreId" tiene valor, se
// asume que ambos debian referenciar el mismo data store y se copia el valor.
function repairDataStoreNameFromId(iflwContent) {
  return iflwContent.replace(
    /<bpmn2:callActivity\s+[^>]*?>[\s\S]*?<\/bpmn2:callActivity>/g,
    block => {
      if (!/<key>activityType<\/key>\s*<value>DBstorage<\/value>/.test(block)) return block
      const storageNameEmpty = /<key>storageName<\/key>\s*<value>\s*<\/value>|<key>storageName<\/key>\s*<value\s*\/>/.test(block)
      if (!storageNameEmpty) return block
      const dataStoreId = (block.match(/<key>dataStoreId<\/key>\s*<value>([^<]+)<\/value>/) || [])[1]
      if (!dataStoreId) return block
      return block.replace(
        /<key>storageName<\/key>\s*<value>\s*<\/value>|<key>storageName<\/key>\s*<value\s*\/>/,
        `<key>storageName</key><value>${dataStoreId}</value>`
      )
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

// Verificacion final de que el .iflw sigue siendo XML bien formado tras aplicar toda la cadena de
// repairs — visto en un diseno real que la IA puede dejar una <ifl:property> sin su cierre (texto
// largo con comillas anidadas en "wrapContent"), lo que produce un XML mal formado que ni el
// editor grafico de Integration Suite consigue abrir, sin ningun aviso previo en la app. Aunque
// repairUnclosedPropertyTags ya cubre el caso concreto visto, esto es una red de seguridad
// general: si CUALQUIER otro defecto de generacion (conocido o no) deja el XML mal formado, se
// bloquea aqui el guardado/despliegue con un mensaje claro en vez de dejar pasar un iflow roto.
function findXmlWellFormednessErrors(xml) {
  const parser = new SaxesParser({ xmlns: true })
  const errors = []
  parser.on('error', e => errors.push(e.message))
  parser.write(xml).close()
  return errors
}

// Verificacion final de que el .iflw es INTERNAMENTE CONSISTENTE como diagrama BPMN2/SAP, mas
// alla de ser XML bien formado — un documento puede ser XML perfectamente valido y aun asi tener
// referencias colgantes (un sourceRef/targetRef/incoming/outgoing que apunta a un id que no
// existe, una BPMNShape/BPMNEdge duplicada para el mismo elemento, un paso sin ninguna BPMNShape)
// que hacen que Integration Suite falle al desplegar o al abrir el editor grafico con mensajes
// tan poco especificos como "Error while loading the details of the integration flow" o
// "NullPointerException: Name is null" — verificado DOS VECES en esta misma sesion con disenos
// reales donde el .iflw pasaba la verificacion de XML bien formado pero tenia una referencia
// colgante introducida por un repair anterior. A diferencia de las funciones "repair*" de este
// fichero (que corrigen lo que SI se puede corregir con confianza, como una property vacia o un
// nombre con espacios), esto NO intenta arreglar nada — no hay forma segura de adivinar cual
// deberia ser la referencia correcta — solo detecta y bloquea, con el mismo criterio que la
// comprobacion de truncamiento y la de bien-formado ya existentes: mejor un error claro en la app
// que un iflow roto guardado silenciosamente.
function findStructuralIntegrityErrors(iflwContent) {
  const errors = []
  const idCounts = {}
  for (const m of iflwContent.matchAll(/\bid="([^"]+)"/g)) idCounts[m[1]] = (idCounts[m[1]] || 0) + 1
  const allIds = new Set(Object.keys(idCounts))
  for (const [id, c] of Object.entries(idCounts)) if (c > 1) errors.push(`ID duplicado: "${id}" (${c} veces)`)

  for (const m of iflwContent.matchAll(/\b(sourceRef|targetRef|bpmnElement)="([^"]+)"/g)) {
    if (!allIds.has(m[2])) errors.push(`Referencia colgante (${m[1]}): "${m[2]}" no existe como id`)
  }
  for (const m of iflwContent.matchAll(/<bpmn2:(incoming|outgoing)>([^<]+)<\/bpmn2:\1>/g)) {
    if (!allIds.has(m[2])) errors.push(`Referencia colgante (${m[1]}): "${m[2]}" no existe como id`)
  }

  const shapeElementRefs = new Set()
  const shapeIds = new Set()
  const shapeCounts = {}
  for (const m of iflwContent.matchAll(/<bpmndi:BPMNShape\s+([^>]*?)>/g)) {
    const ref = getAttr(m[1], 'bpmnElement')
    if (ref) { shapeElementRefs.add(ref); shapeCounts[ref] = (shapeCounts[ref] || 0) + 1 }
    const sid = getAttr(m[1], 'id')
    if (sid) shapeIds.add(sid)
  }
  for (const [ref, c] of Object.entries(shapeCounts)) if (c > 1) errors.push(`BPMNShape duplicada para "${ref}" (${c} veces)`)

  const edgeCounts = {}
  for (const m of iflwContent.matchAll(/<bpmndi:BPMNEdge\s+([^>]*?)>/g)) {
    const ref = getAttr(m[1], 'bpmnElement')
    if (ref) edgeCounts[ref] = (edgeCounts[ref] || 0) + 1
    const srcEl = getAttr(m[1], 'sourceElement')
    const tgtEl = getAttr(m[1], 'targetElement')
    if (srcEl && !shapeIds.has(srcEl)) errors.push(`BPMNEdge con sourceElement colgante: "${srcEl}"`)
    if (tgtEl && !shapeIds.has(tgtEl)) errors.push(`BPMNEdge con targetElement colgante: "${tgtEl}"`)
  }
  for (const [ref, c] of Object.entries(edgeCounts)) if (c > 1) errors.push(`BPMNEdge duplicado para "${ref}" (${c} veces)`)

  for (const m of iflwContent.matchAll(/<bpmn2:(startEvent|endEvent|callActivity|serviceTask|exclusiveGateway|subProcess)\s+([^>]*?)>/g)) {
    const id = getAttr(m[2], 'id')
    if (id && !shapeElementRefs.has(id)) errors.push(`Elemento sin BPMNShape: ${m[1]} "${id}"`)
  }

  return errors
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
  repairSuccessFactorsUpsertOperation,
  repairSuccessFactorsSessionReuse,
  repairIncompleteIFlowConfiguration,
  repairParticipantNameWhitespace,
  repairAdapterNamePropertyWhitespace,
  repairDuplicateChannelNames,
  repairOrphanedExternalizedParameters,
  repairMissingGatewayDefault,
  repairUnclosedPropertyTags,
  repairConditionExpressionOperator,
  repairXpathRowMissingDatatype,
  repairDataStoreNameFromId,
  repairSuccessFactorsAuthMethod,
  findXmlWellFormednessErrors,
  findStructuralIntegrityErrors,
  buildIflowFromTemplate,
  uploadIflowZip,
  createIflowZip,
  deployArtifact
}
