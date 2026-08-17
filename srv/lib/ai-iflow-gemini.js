// Calls Gemini (Google AI Studio API) to build/extend an iflow's content for
// "Diseño de iflow" (Crear/Actualizar) — same client/pattern as
// ai-fix-gemini.js, different schema/prompt (ai-iflow-prompt.js). Same
// free-tier trade-off noted there: lighter reasoning than claude-opus-5, and
// prompts may be used by Google to improve their models.

const { GoogleGenAI } = require('@google/genai')
const { IFLOW_DESIGN_SCHEMA, SYSTEM_PROMPT_CREATE, SYSTEM_PROMPT_UPDATE, buildUserContent } = require('./ai-iflow-prompt')

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
// PRUEBA TEMPORAL (2026-08-17): fijado a 'gemini-3.6-flash', ver el mismo comentario en
// ai-fix-gemini.js - revertir a 'gemini-flash-latest' cuando el usuario lo pida.
const MODEL = 'gemini-3.6-flash'

async function designIflow(context) {
  const systemInstruction = context.mode === 'CREATE' ? SYSTEM_PROMPT_CREATE : SYSTEM_PROMPT_UPDATE

  const response = await client.models.generateContent({
    model: MODEL,
    contents: buildUserContent(context),
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: IFLOW_DESIGN_SCHEMA,
      // maxOutputTokens explícito: con pensamiento dinámico (thinkingBudget: -1) el modelo
      // puede gastar una parte impredecible del presupuesto en razonar, dejando poco margen
      // para la respuesta final — visto cortando literalmente a mitad de una etiqueta el
      // .iflw de un diseño grande (varios adaptadores + subproceso + scripts), sin ningún
      // error, dejando un iflow que ni el editor gráfico de Integration Suite puede abrir.
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: -1 }
    }
  })

  if (!response.text) throw new Error('Gemini no devolvió una propuesta de iflow válida')
  try {
    return JSON.parse(response.text)
  } catch (e) {
    // "Unterminated string in JSON at position X" — la respuesta de Gemini se cortó a mitad de
    // generación (mismo riesgo documentado arriba para maxOutputTokens, pero aqui rompiendo el
    // JSON en si, antes de llegar siquiera a extraer el .iflw) — verificado con un diseño real.
    // Sin este catch, el error crudo de JSON.parse llegaba tal cual a la app, sin explicar la
    // causa ni qué hacer.
    throw new Error(
      'Gemini ha cortado la respuesta a mitad de generación (probablemente por tratarse de un ' +
      `diseño grande) — vuelve a pulsar "Crear"/"Actualizar Iflow", no se ha guardado nada. (${e.message})`
    )
  }
}

module.exports = { designIflow }
