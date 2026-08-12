// Parsea la plantilla Excel de "Diseño de iflow" (srv/templates/plantilla-diseno-iflow.xlsx)
// y construye el mismo tipo de texto "requirements" que ya consume ai-iflow-prompt.js para
// prompt/diseño técnico — así el resto del pipeline (selección de componentes de referencia,
// BASE_RULES, esquema de salida) no necesita ningún cambio, solo una fuente de texto más
// estructurada y sin ambigüedad que un prompt libre.

const ExcelJS = require('exceljs')
const { COMPONENTS } = require('./ai-iflow-components')

const LABEL_BY_ID = new Map(COMPONENTS.map(c => [c.id, c.label]))

const SHEET_PASOS = 'Pasos del iflow'
const SHEET_CM = 'Content Modifier — Detalle'
const SHEET_MS = 'Mapeos y Scripts — Detalle'

// Una celda con fórmula (p. ej. el "Principal" por defecto de la columna Contenedor) solo
// tiene valor real una vez el usuario la ha abierto/guardado en Excel de verdad — en ese
// caso exceljs expone {formula, result}. Sin eso, es un valor plano (string/number/null).
function cellText(cell) {
  const v = cell.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, 'result')) {
      return v.result === null || v.result === undefined ? '' : String(v.result).trim()
    }
    if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text).join('').trim()
    if (v instanceof Date) return v.toISOString()
    return ''
  }
  return String(v).trim()
}

function rowValues(row, nCols) {
  const out = []
  for (let c = 1; c <= nCols; c++) out.push(cellText(row.getCell(c)))
  return out
}

function readRows(worksheet, nCols) {
  const rows = []
  if (!worksheet) return rows
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return // cabecera
    const vals = rowValues(row, nCols)
    if (!vals[0]) return // sin "Orden" informado -> fila sin usar, se ignora
    rows.push(vals)
  })
  return rows
}

function componentLabel(tipoId) {
  return LABEL_BY_ID.get(tipoId) || tipoId
}

function describePaso(paso, cmByOrden, msByOrden, ordenToPaso) {
  const [orden, tipo, nombre, contenedor, sistema, direccion, config, notas] = paso
  const lines = []
  lines.push(`Paso ${orden} — ${componentLabel(tipo)} "${nombre || ''}"`.trim())

  if (contenedor && contenedor !== 'Principal') {
    const contenedorPaso = ordenToPaso.get(String(contenedor))
    const esErrorSubprocess = contenedorPaso && contenedorPaso[1] === 'error-subprocess'
    const contenedorFrase = esErrorSubprocess ? 'Exception Subprocess (manejo de errores)' : 'Local Integration Process'
    const contenedorNombre = contenedorPaso ? contenedorPaso[2] : ''
    lines.push(`  Este paso va DENTRO del ${contenedorFrase} definido en el Paso ${contenedor} ("${contenedorNombre}") — no lo pongas en el flujo principal.`)
  }
  if (sistema) lines.push(`  Sistema: ${sistema}`)
  if (direccion) lines.push(`  Dirección: ${direccion}`)
  if (config) lines.push(`  Configuración: ${config}`)
  if (notas) lines.push(`  Notas/condición: ${notas}`)

  const cmRows = cmByOrden.get(String(orden))
  if (cmRows && cmRows.length) {
    lines.push('  Detalle de Content Modifier (fija exactamente estos Headers/Properties/Body):')
    for (const [, tipoElemento, nombreElemento, valor, tipoValor] of cmRows) {
      const etiqueta = tipoElemento === 'Body' ? 'Body' : `${tipoElemento} "${nombreElemento}"`
      lines.push(`    - ${etiqueta} = "${valor}" (${tipoValor || 'Constante'})`)
    }
  }

  const msRows = msByOrden.get(String(orden))
  if (msRows && msRows.length) {
    for (const [, entrada, salida, contexto] of msRows) {
      lines.push('  Detalle de mapeo/transformación — programa este paso para que, dado este ejemplo de entrada:')
      lines.push(`    ${entrada}`)
      lines.push('  produzca exactamente este ejemplo de salida:')
      lines.push(`    ${salida}`)
      if (contexto) lines.push(`  Contexto/reglas adicionales: ${contexto}`)
    }
  }

  return lines.join('\n')
}

async function parseTemplate(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)

  const wsPasos = workbook.getWorksheet(SHEET_PASOS)
  if (!wsPasos) {
    throw new Error(`La plantilla no contiene la hoja "${SHEET_PASOS}" — usa la plantilla oficial (srv/templates/plantilla-diseno-iflow.xlsx) sin renombrar sus hojas`)
  }

  const pasos = readRows(wsPasos, 8)
  if (!pasos.length) {
    throw new Error(`La hoja "${SHEET_PASOS}" no tiene ninguna fila con "Orden" informado`)
  }

  const cmRows = readRows(workbook.getWorksheet(SHEET_CM), 5)
  const msRows = readRows(workbook.getWorksheet(SHEET_MS), 4)

  const cmByOrden = new Map()
  for (const row of cmRows) {
    const orden = row[0]
    if (!cmByOrden.has(orden)) cmByOrden.set(orden, [])
    cmByOrden.get(orden).push(row)
  }
  const msByOrden = new Map()
  for (const row of msRows) {
    const orden = row[0]
    if (!msByOrden.has(orden)) msByOrden.set(orden, [])
    msByOrden.get(orden).push(row)
  }

  const ordenToPaso = new Map(pasos.map(p => [String(p[0]), p]))

  // Orden numérico (la columna es texto libre en la celda, pero representa un número) para
  // que la secuencia en el texto respete la intención del usuario aunque la hoja no esté
  // perfectamente ordenada de arriba a abajo.
  const pasosOrdenados = [...pasos].sort((a, b) => Number(a[0]) - Number(b[0]))

  const componentIds = [...new Set(pasos.map(p => p[1]).filter(Boolean))]

  const bloques = pasosOrdenados.map(paso => describePaso(paso, cmByOrden, msByOrden, ordenToPaso))

  const intro = 'Diseño de iflow especificado mediante una plantilla estructurada — sigue EXACTAMENTE esta ' +
    'secuencia de pasos, en este orden, respetando los contenedores indicados (Local Integration ' +
    'Process / Exception Subprocess). No añadas pasos que no estén aquí ni cambies el tipo de ' +
    'componente indicado en cada uno.'

  const requirements = [intro, ...bloques].join('\n\n')

  return { requirements, componentIds }
}

module.exports = { parseTemplate }
