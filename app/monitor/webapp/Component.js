sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";

  // sap.fe.core.AppComponent (rather than a plain sap.ui.core.UIComponent) provides the
  // root container and the OData metadata lifecycle that the sap.fe.macros building
  // blocks (FilterBar, Table) used in ext/view/ListReportCustom.view.xml rely on.
  return AppComponent.extend("monitoringis.monitor.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
