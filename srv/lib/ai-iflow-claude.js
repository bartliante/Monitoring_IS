// Calls Claude (Anthropic API) to build/extend an iflow's content for
// "Diseño de iflow" (Crear/Actualizar) — same client/pattern as
// ai-fix-claude.js, different schema/prompt (ai-iflow-prompt.js) since this
// flow can touch several files at once instead of exactly one.

const Anthropic = require('@anthropic-ai/sdk')
const { jsonSchemaOutputFormat } = require('@anthropic-ai/sdk/helpers/json-schema')
const { IFLOW_DESIGN_SCHEMA, SYSTEM_PROMPT_CREATE, SYSTEM_PROMPT_UPDATE, buildUserContent } = require('./ai-iflow-prompt')

const client = new Anthropic()

async function designIflow(context) {
  const systemPrompt = context.mode === 'CREATE' ? SYSTEM_PROMPT_CREATE : SYSTEM_PROMPT_UPDATE

  const message = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: jsonSchemaOutputFormat(IFLOW_DESIGN_SCHEMA)
    },
    system: systemPrompt,
    messages: [{ role: 'user', content: buildUserContent(context) }]
  })

  if (!message.parsed_output) throw new Error('Claude no devolvió una propuesta de iflow válida')
  return message.parsed_output
}

module.exports = { designIflow }
