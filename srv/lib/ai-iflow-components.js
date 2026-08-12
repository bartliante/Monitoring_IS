// Real, working component snippets (BPMN2/ifl XML) extracted from real iflows the user
// shared for exactly this purpose — sanitized where needed (customer-specific values
// replaced with generic placeholders; the exact cmdVariantUri/componentVersion/protocol
// fields, which are the load-bearing part, are left untouched). This exists because the
// AI has no way to know which adapter *version* is valid for a given tenant on its own —
// guessing (even copying "1.0" from the generic Sender/Receiver participant) reliably
// produces iflows that build/deploy-fail with errors like "This component X with version
// Y is not supported", "Timer is not configured", or outright Java exceptions on create
// (wrong parameters.propdef root element, missing required <description/> child) — all
// seen and fixed against a real tenant before this library existed.
//
// Two source iflows, two different purposes:
// - A real production flow (business logic scrubbed out where it mattered) gave the
//   first few adapters/steps and, crucially, the Timer's externalized "custom:schedule"
//   parameter pattern (parameters.prop/parameters.propdef) — not obvious from the .iflw
//   alone, and the only way this got discovered.
// - A purpose-built "catalog" iflow (every component type dragged onto a canvas with no
//   real logic — nothing to sanitize) gave broad, clean coverage: most adapters in both
//   directions, routing/splitting/merging steps, mapping, and process-call patterns.
//
// Caveat that does NOT go away with a correct version string: SuccessFactors (and any
// other certified/product-specific adapter) still requires that adapter's content package
// to be *installed* on whichever tenant the user is targeting. A correct version fixes
// "wrong version" errors, not "adapter package not installed on this tenant" errors — see
// the caveat below, passed through to the AI so it can mention it in "warnings".

const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, 'ai-iflow-components')

function readSnippet(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
}

const CERTIFIED_ADAPTER_CAVEAT = 'Este adaptador es un paquete de contenido certificado — aunque la versión de ' +
  'este ejemplo es real y correcta, sigue haciendo falta que el paquete esté instalado en el tenant de ' +
  'destino. Si el despliegue falla con "not supported in Cloud Integration profile" a pesar de usar esta ' +
  'versión exacta, es porque el paquete no está instalado ahí, no porque la versión esté mal — avísalo en ' +
  '"warnings".'

const MAIL_SEND_CAVEAT = 'El paso que envía este Mail (el "sourceRef" del messageFlow) es "fire-and-forget" — ' +
  'no espera respuesta del servidor SMTP. Debe usar el componente de referencia "Send" ' +
  '(activityType=Send), NUNCA el bloque "ServiceTask ExternalCall" que sí usan los adaptadores de ' +
  'petición-respuesta (HTTP, OData, SuccessFactors, SOAP, JDBC...).'

const COMPONENTS = [
  // --- Adaptadores ---
  { id: 'http-receiver', label: 'Adaptador HTTP (Receiver)', keywords: /\bhttp\b|\brest\b|\bapi\b|\bwebservice\b/i, file: 'http-receiver.xml' },
  { id: 'soap-receiver', label: 'Adaptador SOAP (Receiver)', keywords: /\bsoap\b|\bwsdl\b/i, file: 'soap-receiver.xml' },
  { id: 'soap-sender', label: 'Adaptador SOAP (Sender)', keywords: /\bsoap\b|\bwsdl\b/i, file: 'soap-sender.xml' },
  { id: 'jdbc-receiver', label: 'Adaptador JDBC (Receiver)', keywords: /\bjdbc\b|base de datos|\bsql\b|\bbbdd\b/i, file: 'jdbc-receiver.xml' },
  { id: 'sftp-receiver', label: 'Adaptador SFTP (Receiver)', keywords: /\bsftp\b|\bftp\b|fichero/i, file: 'sftp-receiver.xml' },
  { id: 'sftp-sender', label: 'Adaptador SFTP (Sender)', keywords: /\bsftp\b|\bftp\b|fichero/i, file: 'sftp-sender.xml' },
  { id: 'pollingsftp-sender', label: 'Adaptador Polling SFTP (Sender)', keywords: /\bsftp\b|polling|\bftp\b/i, file: 'pollingsftp-sender.xml' },
  { id: 'as2-sender', label: 'Adaptador AS2 (Sender)', keywords: /\bas2\b/i, file: 'as2-sender.xml' },
  { id: 'as2-receiver', label: 'Adaptador AS2 (Receiver)', keywords: /\bas2\b/i, file: 'as2-receiver.xml' },
  { id: 'idoc-receiver', label: 'Adaptador IDoc (Receiver)', keywords: /\bidoc\b|\bsap\s*ecc\b|\bsap\s*erp\b/i, file: 'idoc-receiver.xml' },
  { id: 'idoc-sender', label: 'Adaptador IDoc (Sender)', keywords: /\bidoc\b|\bsap\s*ecc\b|\bsap\s*erp\b/i, file: 'idoc-sender.xml' },
  { id: 'jms-receiver', label: 'Adaptador JMS (Receiver)', keywords: /\bjms\b|\bcola\b|\bqueue\b/i, file: 'jms-receiver.xml' },
  { id: 'jms-sender', label: 'Adaptador JMS (Sender)', keywords: /\bjms\b|\bcola\b|\bqueue\b/i, file: 'jms-sender.xml' },
  {
    id: 'mail-receiver',
    label: 'Adaptador Mail/SMTP (Receiver)',
    keywords: /\bmail\b|\bcorreo\b|\bemail\b|\bsmtp\b|\bnotificaci/i,
    file: 'mail-receiver.xml',
    caveat: MAIL_SEND_CAVEAT
  },
  { id: 'mail-sender-imap', label: 'Adaptador Mail/IMAP (Sender)', keywords: /\bimap\b/i, file: 'mail-sender-imap.xml' },
  { id: 'mail-sender-pop3', label: 'Adaptador Mail/POP3 (Sender)', keywords: /\bpop3\b/i, file: 'mail-sender-pop3.xml' },
  { id: 'odata-v2-receiver', label: 'Adaptador OData V2 genérico (Receiver)', keywords: /odata\s*v?2|\bodata\b/i, file: 'odata-v2-receiver.xml' },
  { id: 'odata-v4-receiver', label: 'Adaptador OData V4 genérico (Receiver)', keywords: /odata\s*v?4/i, file: 'odata-v4-receiver.xml' },
  { id: 'odata-v2-sender', label: 'Adaptador OData V2 genérico (Sender, exponer servicio)', keywords: /odata\s*v?2.*expone|expone.*odata|odata\s*v?2.*sender/i, file: 'odata-v2-sender.xml' },
  { id: 'processdirect-receiver', label: 'Adaptador ProcessDirect (Receiver)', keywords: /processdirect|process\s*direct/i, file: 'processdirect-receiver.xml' },
  { id: 'processdirect-sender', label: 'Adaptador ProcessDirect (Sender)', keywords: /processdirect|process\s*direct/i, file: 'processdirect-sender.xml' },
  {
    id: 'successfactors-odata-receiver',
    label: 'Adaptador SuccessFactors OData V2 (Receiver)',
    keywords: /successfactors|\bsfsf\b/i,
    file: 'successfactors-odata-receiver.xml',
    caveat: CERTIFIED_ADAPTER_CAVEAT
  },
  {
    id: 'successfactors-soap-receiver-compoundemployee',
    label: 'Adaptador SuccessFactors SOAP (Receiver) — típico para CompoundEmployee',
    keywords: /successfactors|\bsfsf\b|compoundemployee|compound\s*employee/i,
    file: 'successfactors-soap-receiver-compoundemployee.xml',
    caveat: CERTIFIED_ADAPTER_CAVEAT
  },

  // --- Timer / Programación ---
  { id: 'timer-start-event', label: 'Timer Start Event (con planificación externalizada)', keywords: /\btimer\b|programad|planificaci|\bschedule\b|\bcron\b/i, file: 'timer-start-event.xml' },

  // --- Pasos de flujo y control ---
  {
    id: 'external-call-service-task',
    label: 'ServiceTask "ExternalCall" — pieza obligatoria junto a CUALQUIER adaptador',
    keywords: /.*/, // siempre relevante — sin esto el paso queda "sin tipo" y rompe el editor real de SAP
    file: 'external-call-service-task.xml'
  },
  { id: 'groovy-script', label: 'Paso de script Groovy (CallActivity)', keywords: /.*/, file: 'groovy-script.xml' },
  { id: 'content-modifier', label: 'Content Modifier / Enricher (CallActivity)', keywords: /.*/, file: 'content-modifier.xml' },
  { id: 'content-enricher-lookup', label: 'Content Enricher con Lookup (consulta externa antes de enriquecer)', keywords: /lookup|enriquec.*consult|consult.*enriquec/i, file: 'content-enricher-lookup.xml' },
  { id: 'message-mapping', label: 'Message Mapping (mapeo gráfico)', keywords: /mapeo|mapping|transformaci/i, file: 'message-mapping.xml' },
  { id: 'router', label: 'Router / Exclusive Gateway (con condiciones de ruta)', keywords: /router|enrutad|condici|\bif\b|bifurcaci/i, file: 'router.xml' },
  { id: 'splitter', label: 'Splitter (dividir un mensaje en varios)', keywords: /splitter|dividir|split\b/i, file: 'splitter.xml' },
  { id: 'gather', label: 'Gather (recomponer tras un split)', keywords: /gather|recompon|reagrupar/i, file: 'gather.xml' },
  { id: 'join', label: 'Join (unir ramas paralelas)', keywords: /\bjoin\b|unir ramas/i, file: 'join.xml' },
  { id: 'multicast-parallel', label: 'Multicast paralelo', keywords: /multicast.*paralel|paralel.*multicast|en paralelo/i, file: 'multicast-parallel.xml' },
  { id: 'multicast-sequential', label: 'Multicast secuencial', keywords: /multicast.*secuencial|secuencial.*multicast/i, file: 'multicast-sequential.xml' },
  { id: 'filter', label: 'Filter (filtrar partes del mensaje)', keywords: /\bfilter\b|\bfiltrar\b/i, file: 'filter.xml' },
  { id: 'send', label: 'Send (fire-and-forget, sin esperar respuesta — usar SIEMPRE con el adaptador Mail)', keywords: /fire.and.forget|sin esperar respuesta|\bsend\b step|\bmail\b|\bcorreo\b|\bemail\b|\bsmtp\b|\bnotificaci/i, file: 'send.xml' },
  { id: 'poll-enrich', label: 'Poll Enrich (enriquecer haciendo poll a otro adaptador)', keywords: /poll\s*enrich/i, file: 'poll-enrich.xml' },
  { id: 'looping-process-call', label: 'Llamada a proceso con bucle (Looping Process Call)', keywords: /bucle|loop\b|repetir para cada/i, file: 'looping-process-call.xml' },
  { id: 'local-integration-process', label: 'Definición de un Local Integration Process', keywords: /local integration process|proceso local/i, file: 'local-integration-process.xml' },
  { id: 'local-process-call', label: 'Llamada a un Local Integration Process (Process Call)', keywords: /local integration process|proceso local|process call/i, file: 'local-process-call.xml' },
  { id: 'error-subprocess', label: 'Exception Subprocess (manejo de errores)', keywords: /excepci|\berror\b.*manej|manej.*error|try.*catch/i, file: 'error-subprocess.xml' },
  { id: 'iterating-splitter', label: 'Iterating Splitter (Camel, alternativa a General Splitter)', keywords: /iterating splitter|splitter.*iterat/i, file: 'iterating-splitter.xml' },

  // --- Almacenamiento / variables ---
  { id: 'data-store-write', label: 'Data Store Operations — Write', keywords: /data\s*store|almac[eé]n.*mensaje|write.*data\s*store/i, file: 'data-store-write.xml' },
  { id: 'data-store-select', label: 'Data Store Operations — Select', keywords: /data\s*store|almac[eé]n.*mensaje|select.*data\s*store/i, file: 'data-store-select.xml' },
  { id: 'data-store-get', label: 'Data Store Operations — Get', keywords: /data\s*store|almac[eé]n.*mensaje|get.*data\s*store/i, file: 'data-store-get.xml' },
  { id: 'data-store-delete', label: 'Data Store Operations — Delete', keywords: /data\s*store|almac[eé]n.*mensaje|delete.*data\s*store/i, file: 'data-store-delete.xml' },
  { id: 'write-variables', label: 'Write Variables (persistir variables entre ejecuciones)', keywords: /write variables|variables? persist/i, file: 'write-variables.xml' },
  { id: 'persist', label: 'Persist (guardar el mensaje para Message Store)', keywords: /\bpersist\b|message\s*store/i, file: 'persist.xml' },

  // --- Conversores de formato ---
  { id: 'csv-to-xml', label: 'Conversor CSV → XML', keywords: /csv.*xml|convert.*csv/i, file: 'csv-to-xml.xml' },
  { id: 'xml-to-csv', label: 'Conversor XML → CSV', keywords: /xml.*csv|convert.*csv/i, file: 'xml-to-csv.xml' },
  { id: 'json-to-xml', label: 'Conversor JSON → XML', keywords: /json.*xml/i, file: 'json-to-xml.xml' },
  { id: 'xml-to-json', label: 'Conversor XML → JSON', keywords: /xml.*json/i, file: 'xml-to-json.xml' },
  { id: 'edi-to-xml', label: 'Conversor EDI → XML', keywords: /\bedi\b.*xml|edifact/i, file: 'edi-to-xml.xml' },
  { id: 'xml-to-edi', label: 'Conversor XML → EDI', keywords: /xml.*\bedi\b|edifact/i, file: 'xml-to-edi.xml' },
  { id: 'base64-decode', label: 'Base64 Decoder', keywords: /base64.*decod|decod.*base64/i, file: 'base64-decode.xml' },
  { id: 'base64-encode', label: 'Base64 Encoder', keywords: /base64.*encod|encod.*base64/i, file: 'base64-encode.xml' },
  { id: 'gzip-compress', label: 'GZIP Compression', keywords: /gzip/i, file: 'gzip-compress.xml' },
  { id: 'gzip-decompress', label: 'GZIP Decompression', keywords: /gzip/i, file: 'gzip-decompress.xml' },
  { id: 'zip-compress', label: 'ZIP Compression', keywords: /\bzip\b/i, file: 'zip-compress.xml' },
  { id: 'zip-decompress', label: 'ZIP Decompression', keywords: /\bzip\b/i, file: 'zip-decompress.xml' },
  { id: 'mime-multipart-decode', label: 'MIME Multipart Decoder', keywords: /mime.*multipart|multipart.*mime/i, file: 'mime-multipart-decode.xml' },
  { id: 'mime-multipart-encode', label: 'MIME Multipart Encoder', keywords: /mime.*multipart|multipart.*mime/i, file: 'mime-multipart-encode.xml' },
  { id: 'pgp-decrypt', label: 'PGP Decryptor', keywords: /pgp.*decrypt|descifr.*pgp/i, file: 'pgp-decrypt.xml' },
  { id: 'pgp-encrypt', label: 'PGP Encryptor', keywords: /pgp.*encrypt|cifr.*pgp/i, file: 'pgp-encrypt.xml' }
]

// Returns the components whose keywords match the given requirements text (most snippets
// are conditional on a keyword match; groovy-script/content-modifier match everything, so
// they're always included as a baseline reference for their correct cmdVariantUri).
function selectRelevantComponents(text) {
  const haystack = text || ''
  return COMPONENTS
    .filter(c => c.keywords.test(haystack))
    .map(c => ({ id: c.id, label: c.label, xml: readSnippet(c.file), caveat: c.caveat }))
}

// Same output shape as selectRelevantComponents, but selects by an exact set of component
// ids instead of matching keywords against free text — used for "Diseño de iflow" > Crear a
// través de una plantilla, where the Excel template's "Tipo de componente" column already IS
// the id (picked from a validated dropdown), so there's no ambiguity left to resolve with a
// regex. Always-relevant components (keywords: /.*/) are included regardless, same as the
// text-based path.
function selectComponentsByIds(ids) {
  const idSet = new Set(ids || [])
  return COMPONENTS
    .filter(c => idSet.has(c.id) || c.keywords.test(''))
    .map(c => ({ id: c.id, label: c.label, xml: readSnippet(c.file), caveat: c.caveat }))
}

module.exports = { selectRelevantComponents, selectComponentsByIds, COMPONENTS }
