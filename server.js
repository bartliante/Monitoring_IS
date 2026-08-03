const cds = require('@sap/cds')

// "/" is normally the CAP-generated welcome page (services + apps overview) —
// see node_modules/@sap/cds/server.js: `if (o.index) app.get('/', o.index)`.
// We want "/" to load the shell app directly instead, so the welcome page
// moves to /dev (same page, reusing CAP's own renderer, not duplicated here).
cds.on('bootstrap', app => {
  app.get('/', (_, res) => res.redirect('/shell/webapp/index.html'))
  app.get('/dev', (_, res) => res.send(require('@sap/cds/app/index.js').html))
})

module.exports = cds.server
