// Translates a CQN SELECT against MonitorService.MessageProcessingLogs (which includes
// the filter-only virtual fields SearchId/TimePreset/CustomFrom/CustomTo) into a CQN
// SELECT against the remote CloudIntegrationAPI.MessageProcessingLogs entity, whose
// columns share names 1:1 with ours except for those virtual fields.

const SEARCH_FIELD = 'SearchId'
const PRESET_FIELD = 'TimePreset'
const FROM_FIELD = 'CustomFrom'
const TO_FIELD = 'CustomTo'
const LOG_START = 'LogStart'

const PRESET_TO_MS = {
  LAST_HOUR: 60 * 60 * 1000,
  LAST_24_HOURS: 24 * 60 * 60 * 1000,
  LAST_WEEK: 7 * 24 * 60 * 60 * 1000
}

// The real Cloud Integration OData v2 API rejects `$select=*` with a flat
// "501 Not Implemented" — which is exactly what CAP's OData v2 remote adapter
// sends whenever a query has no explicit `columns` (verified against a real
// trial tenant). So we always list the actual remote columns explicitly
// instead of forwarding the incoming (possibly column-less) query as is.
const REMOTE_COLUMNS = [
  'MessageGuid', 'CorrelationId', 'ApplicationMessageId', 'ApplicationMessageType', 'PredecessorMessageGuid',
  'IntegrationFlowName', 'Status', 'LogLevel', 'LogStart', 'LogEnd', 'Sender', 'Receiver',
  'CustomStatus', 'TransactionId', 'PreviousComponentName', 'LocalComponentName', 'OriginComponentName',
  'AlternateWebLink'
]

// Pulls every top-level (AND-combined) comparison on `column` out of a flat CQN
// `where` array, returning the matches and what's left. Assumes the shape the CAP
// OData v4 adapter produces for simple filter-bar conditions: refs are ANDed at the
// top level, multi-value selects on the same field are grouped in their own `xpr`.
function extractColumn(where, column) {
  const matches = []
  const rest = []
  let i = 0
  while (i < where.length) {
    const tok = where[i]
    if (tok && tok.ref && tok.ref[tok.ref.length - 1] === column) {
      matches.push({ op: where[i + 1], rhs: where[i + 2] })
      i += 3
      if (where[i] === 'and') i++
      continue
    }
    rest.push(tok)
    i++
  }
  while (rest.length && rest[rest.length - 1] === 'and') rest.pop()
  if (rest.length && rest[0] === 'and') rest.shift()
  return { matches, rest }
}

function valueOf(rhs) {
  return rhs && typeof rhs === 'object' && 'val' in rhs ? rhs.val : undefined
}

function translateMessageProcessingLogsQuery(query, remoteEntity) {
  const q = { ...query, SELECT: { ...query.SELECT } }
  let where = [...(q.SELECT.where || [])]

  const search = extractColumn(where, SEARCH_FIELD); where = search.rest
  const preset = extractColumn(where, PRESET_FIELD); where = preset.rest
  const from = extractColumn(where, FROM_FIELD); where = from.rest
  const to = extractColumn(where, TO_FIELD); where = to.rest

  const extra = []
  const and = () => { if (extra.length) extra.push('and') }

  const searchVal = search.matches.length && valueOf(search.matches[0].rhs)
  if (searchVal) {
    and()
    extra.push(
      '(',
      { ref: ['MessageGuid'] }, '=', { val: searchVal }, 'or',
      { ref: ['CorrelationId'] }, '=', { val: searchVal }, 'or',
      { ref: ['ApplicationMessageId'] }, '=', { val: searchVal },
      ')'
    )
  }

  const presetVal = preset.matches.length && valueOf(preset.matches[0].rhs)
  const fromVal = from.matches.length && valueOf(from.matches[0].rhs)
  const toVal = to.matches.length && valueOf(to.matches[0].rhs)

  // A preset takes precedence when given; otherwise fall back to whatever custom
  // from/to the user picked directly (the two mechanisms requirement 3a asks for:
  // a quick preset, or picking the exact desired time range).
  let rangeFrom, rangeTo
  if (presetVal && PRESET_TO_MS[presetVal]) {
    rangeTo = new Date()
    rangeFrom = new Date(rangeTo.getTime() - PRESET_TO_MS[presetVal])
  } else {
    if (fromVal) rangeFrom = new Date(fromVal)
    if (toVal) rangeTo = new Date(toVal)
  }

  if (rangeFrom) { and(); extra.push({ ref: [LOG_START] }, '>=', { val: rangeFrom.toISOString() }) }
  if (rangeTo) { and(); extra.push({ ref: [LOG_START] }, '<=', { val: rangeTo.toISOString() }) }

  if (extra.length) where = where.length ? [...where, 'and', ...extra] : extra

  q.SELECT.from = { ref: [remoteEntity] }
  q.SELECT.where = where.length ? where : undefined
  q.SELECT.columns = REMOTE_COLUMNS.map(c => ({ ref: [c] }))
  return q
}

// com.sap.vocabularies.UI.v1.CriticalityType values, used to color the Status
// column (see @UI.LineItem's Criticality in monitor-service-ui.cds):
// Neutral=0, Negative=1, Critical=2, Positive=3.
const STATUS_CRITICALITY = {
  COMPLETED: 3,  // green
  FAILED: 1,     // red
  ESCALATED: 1,  // red — an escalated message is still a failure needing attention
  RETRY: 2,      // orange — transient, being retried
  DISCARDED: 0,  // neutral — no further processing intended
  PROCESSING: 0  // neutral — still in flight
}

function criticalityForStatus(status) {
  return STATUS_CRITICALITY[status] ?? 0
}

module.exports = { translateMessageProcessingLogsQuery, criticalityForStatus }
