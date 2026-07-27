sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";

  // sap.fe.core.AppComponent (rather than a plain sap.ui.core.UIComponent) provides the
  // root container and the OData metadata lifecycle that the sap.fe.macros building
  // blocks (FilterBar, Table) used in ext/view/ListReportCustom.view.xml rely on.
  return AppComponent.extend("monitoringis.monitor.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      // Always start at the plain list route: with FCL enabled, a stale hash
      // from a previous session (e.g. .../MessageProcessingLogs('x')?layout=
      // TwoColumnsMidExpanded) would otherwise reopen the two-column split
      // with an empty/broken detail pane before any system is even selected.
      if (window.location.hash && window.location.hash !== "#" && window.location.hash !== "#/") {
        window.location.hash = "";
      }
      AppComponent.prototype.init.apply(this, arguments);
    }
  });
});
