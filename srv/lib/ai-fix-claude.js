// Calls Claude (Anthropic API) to diagnose a failed iflow execution and
// propose a fix for exactly one file. Reads ANTHROPIC_API_KEY from the
// environment (see the plan's ".env" setup) — never exposed to the browser.

const Anthropic = require('@anthropic-ai/sdk')
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema')
const { SUGGESTION_SCHEMA, SYSTEM_PROMPT, buildUserContent } = require('./ai-fix-prompt')

const client = new Anthropic()

async function diagnoseAndFix(context) {
  const message = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: jsonSchemaOutputFormat(SUGGESTION_SCHEMA)
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserContent(context) }]
  })

  if (!message.parsed_output) throw new Error('Claude no devolvió una sugerencia válida')
  return message.parsed_output
}

module.exports = { diagnoseAndFix }
