// Real, working component snippets (BPMN2/ifl XML) extracted from an actual production
// iflow the user shared for exactly this purpose — sanitized (customer-specific values
// replaced with generic placeholders; the exact cmdVariantUri/componentVersion/protocol
// fields, which are the load-bearing part, are left untouched). This exists because the
// AI has no way to know which adapter *version* is valid for a given tenant on its own —
// guessing (even copying "1.0" from the generic Sender/Receiver participant) reliably
// produces iflows that build/deploy-fail with errors like "This component X with version
// Y is not supported" or "Timer is not configured" (both seen against a real tenant
// before this existed). Giving the AI a real, previously-deployed example to copy from is
// far more reliable than asking it to recall the right version from training data.
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

const COMPONENTS = [
  {
    id: 'http-receiver',
    label: 'Adaptador HTTP (Receiver)',
    keywords: /\bhttp\b|\brest\b|\bapi\b|\bwebservice\b/i,
    file: 'http-receiver.xml'
  },
  {
    id: 'mail-receiver',
    label: 'Adaptador Mail/SMTP (Receiver)',
    keywords: /\bmail\b|\bcorreo\b|\bemail\b|\bsmtp\b|\bnotificaci/i,
    file: 'mail-receiver.xml'
  },
  {
    id: 'successfactors-odata-receiver',
    label: 'Adaptador SuccessFactors OData V2 (Receiver)',
    keywords: /successfactors|\bsfsf\b/i,
    file: 'successfactors-odata-receiver.xml',
    caveat: 'Este adaptador es un paquete de contenido certificado — aunque la versión de este ' +
      'ejemplo es real y correcta, sigue haciendo falta que el paquete "SuccessFactors" esté ' +
      'instalado en el tenant de destino. Si el despliegue falla con "not supported in Cloud ' +
      'Integration profile" a pesar de usar esta versión exacta, es porque el paquete no está ' +
      'instalado ahí, no porque la versión esté mal — avísalo en "warnings".'
  },
  {
    id: 'timer-start-event',
    label: 'Timer Start Event (con planificación externalizada)',
    keywords: /\btimer\b|programad|planificaci|\bschedule\b|\bcron\b/i,
    file: 'timer-start-event.xml'
  },
  {
    id: 'groovy-script',
    label: 'Paso de script Groovy (CallActivity)',
    keywords: /.*/, // siempre relevante — casi todos los flujos acaban necesitando algún script
    file: 'groovy-script.xml'
  },
  {
    id: 'content-modifier',
    label: 'Content Modifier / Enricher (CallActivity)',
    keywords: /.*/, // siempre relevante — casi todos los flujos acaban necesitando fijar propiedades/cabeceras
    file: 'content-modifier.xml'
  }
]

// Returns the components whose keywords match the given requirements text (Timer/adapter
// snippets are conditional; groovy-script/content-modifier's keywords match everything, so
// they're always included as a baseline reference for their correct cmdVariantUri).
function selectRelevantComponents(text) {
  const haystack = text || ''
  return COMPONENTS
    .filter(c => c.keywords.test(haystack))
    .map(c => ({ id: c.id, label: c.label, xml: readSnippet(c.file), caveat: c.caveat }))
}

module.exports = { selectRelevantComponents }
