const cds = require('@sap/cds')
const path = require('path')

// "/" is normally the CAP-generated welcome page (services + apps overview) —
// see node_modules/@sap/cds/server.js: `if (o.index) app.get('/', o.index)`.
// We want "/" to load the shell app directly instead, so the welcome page
// moves to /dev (same page, reusing CAP's own renderer, not duplicated here).
cds.on('bootstrap', app => {
  app.get('/', (_, res) => res.redirect('/shell/webapp/index.html'))
  app.get('/dev', (_, res) => res.send(require('@sap/cds/app/index.js').html))

  // Descarga directa de la plantilla Excel de "Diseño de iflow" — fuera del mount OData
  // (/monitor) a propósito, para no interferir con su enrutado. Sin autenticación: es solo
  // un fichero de referencia genérico (vocabulario de componentes), sin datos de negocio,
  // igual que el resto de estáticos de la SPA (index.html, manifest.json...).
  app.get('/templates/plantilla-diseno-iflow.xlsx', (_, res) => {
    res.download(
      path.join(__dirname, 'srv', 'templates', 'plantilla-diseno-iflow.xlsx'),
      'plantilla-diseno-iflow.xlsx'
    )
  })
})

module.exports = cds.server
