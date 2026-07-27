const cds = require('@sap/cds')
const { SELECT } = cds.ql

const destinationsAdmin = require('./lib/destinations-admin')
const { getRemoteFor, invalidate } = require('./lib/remote-connect')
const { translateMessageProcessingLogsQuery } = require('./lib/query-translate')

module.exports = cds.service.impl(async function () {
  const { Systems, Artifacts, MessageProcessingLogs } = this.entities

  this.on('READ', Systems, async () => destinationsAdmin.list())

  this.on('READ', Artifacts, async req => {
    const system = req.headers['x-system-destination']
    if (!system) return []
    const remote = await getRemoteFor(system)
    const artifacts = await remote.run(SELECT.from('IntegrationRuntimeArtifacts').columns('Id', 'Name'))
    return artifacts.map(a => ({ Id: a.Id, Name: a.Name }))
  })

  this.on('READ', MessageProcessingLogs, async req => {
    const system = req.headers['x-system-destination']
    if (!system) return req.reject(400, 'Selecciona un sistema antes de consultar ejecuciones')
    const remote = await getRemoteFor(system)
    const remoteQuery = translateMessageProcessingLogsQuery(req.query, 'MessageProcessingLogs')
    return remote.run(remoteQuery)
  })

  this.on('createConnection', async req => {
    const { name, apiUrl, tokenUrl, clientId, clientSecret } = req.data
    if (!name || !apiUrl || !tokenUrl || !clientId || !clientSecret) {
      return req.reject(400, 'Todos los campos son obligatorios')
    }
    invalidate(name)
    try {
      return await destinationsAdmin.create({ name, apiUrl, tokenUrl, clientId, clientSecret })
    } catch (e) {
      return req.reject(400, e.message)
    }
  })

  this.on('deleteConnection', async req => {
    const { name } = req.data
    invalidate(name)
    await destinationsAdmin.remove(name)
  })
})
