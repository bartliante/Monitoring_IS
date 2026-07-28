// Picks which AI provider diagnoses/fixes iflow errors, based on AI_PROVIDER
// (.env / Cloud Foundry user-provided variable): 'claude' (default) uses
// ai-fix-claude.js (ANTHROPIC_API_KEY, paid); 'gemini' uses ai-fix-gemini.js
// (GEMINI_API_KEY, has a free tier). Both expose the same
// diagnoseAndFix(context) signature, so nothing else in the app needs to know
// which one is active.
//
// Resolved lazily (on first call, not at require time) so a typo in
// AI_PROVIDER fails the "Analizar con IA" action with a clear 500 instead of
// crashing the whole server at startup.

const PROVIDERS = {
  claude: './ai-fix-claude',
  gemini: './ai-fix-gemini'
}

function loadProvider() {
  const name = (process.env.AI_PROVIDER || 'claude').trim().toLowerCase()
  const modulePath = PROVIDERS[name]
  if (!modulePath) {
    throw new Error(`AI_PROVIDER='${process.env.AI_PROVIDER}' no reconocido — usa 'claude' o 'gemini'`)
  }
  return require(modulePath)
}

async function diagnoseAndFix(context) {
  return loadProvider().diagnoseAndFix(context)
}

module.exports = { diagnoseAndFix }
