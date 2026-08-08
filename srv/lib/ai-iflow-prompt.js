// Shared between AI providers (ai-iflow-claude.js / ai-iflow-gemini.js): the
// expected output shape and the system/user prompt content for "Diseño de
// iflow" (Crear/Actualizar), same role ai-fix-prompt.js plays for the "IA -
// Sugerencia de corrección" flow. Unlike that flow (fixes exactly one file),
// this one can touch several files at once — the .iflw plus any scripts it
// adds — since building/extending a flow is rarely a single-file change.

const { serializeFiles } = require('./ai-fix-prompt')

const IFLOW_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Resumen en español de lo que se ha construido o modificado en el iflow' },
    warnings: { type: 'string', description: 'Advertencias o limitaciones del resultado (cadena vacía si no hay ninguna)' },
    files: {
      type: 'array',
      description: 'Ficheros del ZIP del iflow a crear o sobrescribir con su contenido completo',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta exacta dentro del ZIP (una de las ya dadas, o una ruta nueva bajo src/main/resources/script/ o src/main/resources/mapping/ para un fichero nuevo)' },
          content: { type: 'string', description: 'Contenido COMPLETO del fichero ya corregido/creado, no un diff' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'warnings', 'files'],
  additionalProperties: false
}

const BASE_RULES = `Reglas estrictas:
- "path" debe ser exactamente una de las rutas de fichero ya dadas, o una ruta nueva razonable bajo \
src/main/resources/script/ (Groovy/JavaScript) o src/main/resources/mapping/ si el flujo necesita un \
componente de script/mapping que no existía.
- "content" debe ser el contenido COMPLETO de cada fichero, nunca un diff ni un fragmento.
- No modifiques ni renombres el fichero .iflw dado — edítalo en el sitio (mismo "path").
- No inventes IDs de sistemas SAP Integration Suite ni credenciales; para adaptadores/canales usa \
valores de ejemplo razonables que el usuario pueda configurar después en las Configuraciones del iflow.
- Si los requisitos no pueden cumplirse por completo, haz lo posible y explica la limitación en "warnings".`

const SYSTEM_PROMPT_CREATE = `Eres un experto en SAP Cloud Integration (Integration Suite / iflows). Se te da \
el esqueleto de un iflow vacío recién creado (definición gráfica .iflw sin pasos, solo Sender/Receiver/Start/End) \
y unos requisitos funcionales (prompt del usuario o texto extraído de un diseño técnico).

Tu tarea: extender ese esqueleto añadiendo los pasos necesarios (content modifiers, mappings, llamadas a \
sistemas, routers, etc.) dentro del MISMO fichero .iflw para implementar los requisitos, añadiendo también \
cualquier script/mapping que haga falta como fichero nuevo.

${BASE_RULES}`

const SYSTEM_PROMPT_UPDATE = `Eres un experto en SAP Cloud Integration (Integration Suite / iflows). Se te da \
la definición gráfica (.iflw) y los scripts/mappings de un iflow YA EXISTENTE, junto con una petición de cambio \
(prompt del usuario o texto extraído de un diseño técnico).

Tu tarea: modificar ese iflow para satisfacer la petición, tocando solo lo necesario y preservando el resto \
del flujo intacto.

${BASE_RULES}`

function buildUserContent({ mode, artifactName, description, sender, receiver, requirements, flowXml, scripts }) {
  return `## Iflow
Nombre: ${artifactName}
Descripción: ${description || '(sin descripción)'}
Sender: ${sender || '(sin especificar)'}
Receiver: ${receiver || '(sin especificar)'}

## Requisitos
${requirements || '(sin requisitos especificados)'}

## Definición gráfica actual (.iflw)
${serializeFiles('definición de flujo', flowXml)}

## Scripts y mappings actuales
${serializeFiles('scripts', scripts)}`
}

module.exports = {
  IFLOW_DESIGN_SCHEMA,
  SYSTEM_PROMPT_CREATE,
  SYSTEM_PROMPT_UPDATE,
  buildUserContent
}
