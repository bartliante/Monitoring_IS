// Extracts plain text from a "diseño técnico" attachment so both AI
// providers can be fed the same kind of content (plain text) regardless of
// the original file format — simpler and more uniform than handling native
// PDF/DOCX document blocks per provider. Known limitation: diagrams/images
// inside the document are not "seen" by the AI, only their surrounding text.

const pdfParse = require('pdf-parse')
const mammoth = require('mammoth')

async function extractText(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop()
  if (ext === 'pdf') {
    const { text } = await pdfParse(buffer)
    return text
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer })
    return value
  }
  throw new Error(`Formato de diseño técnico no soportado: '${filename}' (solo .pdf y .docx)`)
}

module.exports = { extractText }
