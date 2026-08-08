// Picks which AI provider builds/extends an iflow's content for "Diseño de
// iflow", based on AI_PROVIDER — same dispatcher pattern as ai-fix.js
// (lazy-loaded so a typo fails the designIflow action with a clear 500
// instead of crashing the whole server at startup).

const PROVIDERS = {
  claude: './ai-iflow-claude',
  gemini: './ai-iflow-gemini'
}

function loadProvider() {
  const name = (process.env.AI_PROVIDER || 'claude').trim().toLowerCase()
  const modulePath = PROVIDERS[name]
  if (!modulePath) {
    throw new Error(`AI_PROVIDER='${process.env.AI_PROVIDER}' no reconocido — usa 'claude' o 'gemini'`)
  }
  return require(modulePath)
}

async function designIflow(context) {
  return loadProvider().designIflow(context)
}

module.exports = { designIflow }
