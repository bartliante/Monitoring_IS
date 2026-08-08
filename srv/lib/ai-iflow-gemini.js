// Calls Gemini (Google AI Studio API) to build/extend an iflow's content for
// "Diseño de iflow" (Crear/Actualizar) — same client/pattern as
// ai-fix-gemini.js, different schema/prompt (ai-iflow-prompt.js). Same
// free-tier trade-off noted there: lighter reasoning than claude-opus-5, and
// prompts may be used by Google to improve their models.

const { GoogleGenAI } = require('@google/genai')
const { IFLOW_DESIGN_SCHEMA, SYSTEM_PROMPT_CREATE, SYSTEM_PROMPT_UPDATE, buildUserContent } = require('./ai-iflow-prompt')

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
const MODEL = 'gemini-flash-latest'

async function designIflow(context) {
  const systemInstruction = context.mode === 'CREATE' ? SYSTEM_PROMPT_CREATE : SYSTEM_PROMPT_UPDATE

  const response = await client.models.generateContent({
    model: MODEL,
    contents: buildUserContent(context),
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: IFLOW_DESIGN_SCHEMA,
      thinkingConfig: { thinkingBudget: -1 }
    }
  })

  if (!response.text) throw new Error('Gemini no devolvió una propuesta de iflow válida')
  return JSON.parse(response.text)
}

module.exports = { designIflow }
