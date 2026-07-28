// Shared between AI providers (ai-fix-claude.js / ai-fix-gemini.js): the
// expected output shape and the system/user prompt content don't change with
// the provider, only how the API call is made.

const SUGGESTION_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', description: 'Diagnóstico breve de la causa raíz del error' },
    filePath: { type: 'string', description: 'Ruta exacta (tal cual aparece en la lista de ficheros dada) del único fichero a corregir' },
    proposedCode: { type: 'string', description: 'Contenido COMPLETO y corregido de ese fichero — no un diff/patch' },
    explanation: { type: 'string', description: 'Explicación de qué cambia el fix propuesto y por qué soluciona el error' }
  },
  required: ['diagnosis', 'filePath', 'proposedCode', 'explanation'],
  additionalProperties: false
}

const SYSTEM_PROMPT = `Eres un experto en SAP Cloud Integration (Integration Suite / iflows). Se te da la traza \
de error de una ejecución fallida, sus adjuntos (payloads de entrada/salida), la definición gráfica del \
flujo (XML .iflw) y el código (Groovy/JavaScript/mapping) de sus componentes de script.

Tu tarea: diagnosticar la causa raíz y proponer una corrección.

Reglas estrictas:
- Debes quedarte con UN ÚNICO fichero a modificar (el que más probablemente resuelve el error).
- "filePath" debe ser exactamente una de las rutas que se te han dado (no inventes rutas nuevas).
- "proposedCode" debe ser el contenido COMPLETO del fichero ya corregido, no un diff ni un fragmento.
- Si el error no puede aislarse a un único fichero de script/mapping (p. ej. requiere cambiar la \
configuración del propio flujo gráfico), elige igualmente el fichero más relevante y explica la limitación \
en "explanation".`

function serializeFiles(label, files) {
  if (!files.length) return `(sin ${label})`
  return files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n')
}

function buildUserContent({ errorTrace, attachments, flowXml, scripts, logContext }) {
  return `## Contexto de la ejecución
${JSON.stringify(logContext, null, 2)}

## Traza de error
${errorTrace || '(vacía)'}

## Adjuntos
${(attachments || []).map(a => `--- ${a.Name} (${a.ContentType}) ---\n${a.Content}`).join('\n\n') || '(sin adjuntos)'}

## Definición gráfica del flujo (.iflw)
${serializeFiles('definición de flujo', flowXml)}

## Scripts y mappings
${serializeFiles('scripts', scripts)}`
}

module.exports = { SUGGESTION_SCHEMA, SYSTEM_PROMPT, buildUserContent }
