// Calls Gemini (Google AI Studio API) to diagnose a failed iflow execution and
// propose a fix for exactly one file. Reads GEMINI_API_KEY from the
// environment — never exposed to the browser. Alternative to ai-fix-claude.js,
// selected via AI_PROVIDER=gemini (see ai-fix.js) — mainly so the "Analizar
// con IA" step can run on Google AI Studio's free tier instead of a paid
// Anthropic key. Trade-off the user should be aware of: the free tier only
// covers Flash-class models (lighter reasoning than claude-opus-5) and its
// terms allow Google to use free-tier prompts to improve their models, which
// matters here since prompts include real error traces/payloads/iflow code.

const { GoogleGenAI } = require('@google/genai')
const { SUGGESTION_SCHEMA, SYSTEM_PROMPT, buildUserContent } = require('./ai-fix-prompt')

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// The "-latest" alias (rather than a dated model like 'gemini-2.5-flash',
// which broke with "no longer available to new users" days after being
// wired in) keeps pointing at whatever Flash-class model Google currently
// recommends, sparing this from repeated model-deprecation breakage.
const MODEL = 'gemini-flash-latest'

async function diagnoseAndFix(context) {
  const response = await client.models.generateContent({
    model: MODEL,
    contents: buildUserContent(context),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: SUGGESTION_SCHEMA,
      thinkingConfig: { thinkingBudget: -1 }
    }
  })

  if (!response.text) throw new Error('Gemini no devolvió una sugerencia válida')
  return JSON.parse(response.text)
}

module.exports = { diagnoseAndFix }
