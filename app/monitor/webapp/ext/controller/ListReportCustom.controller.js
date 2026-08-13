sap.ui.define([
  "sap/fe/core/PageController"
], function (PageController) {
  "use strict";

  const SYSTEM_STORAGE_KEY = "monitoringIS.system";
  const SYSTEM_HEADER = "x-system-destination";
  const EVENT_CHANNEL = "monitoringIS";
  const EVENT_SYSTEM_CHANGED = "systemChanged";

  // sap.fe.macros building blocks (FilterBar, Table) are designed to run inside
  // a page hosted by sap.fe.core.fpm, whose controller must extend
  // sap.fe.core.PageController — it wires up the extension API and other
  // FE-internal plumbing the macros reach into (e.g. on "Go"/search). A plain
  // sap.ui.core.mvc.Controller renders fine but throws
  // "this.getPageController(...)?.getExtensionAPI is not a function" the
  // moment a search/rebind actually happens.
  return PageController.extend("monitoringis.monitor.ext.controller.ListReportCustom", {

    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments)

      sap.ui.getCore().getEventBus().subscribe(EVENT_CHANNEL, EVENT_SYSTEM_CHANGED, this._onSystemChangedExternally, this);

      const oView = this.getView();
      const oModel = oView.getModel();
      if (oModel) {
        this._restoreSystemSelection(oModel);
      } else {
        // The custom page's model isn't always attached yet when a Custom Page's
        // onInit runs (routing/FPM timing) — wait for it instead of crashing.
        oView.attachEventOnce("modelContextChange", () => {
          const oLateModel = oView.getModel();
          if (oLateModel) this._restoreSystemSelection(oLateModel);
        });
      }
    },

    onExit: function () {
      sap.ui.getCore().getEventBus().unsubscribe(EVENT_CHANNEL, EVENT_SYSTEM_CHANGED, this._onSystemChangedExternally, this);
    },

    // The system selector now lives in the shared shell toolbar (app/shell),
    // which owns its own OData model instance — this component's model needs
    // the header applied independently, both on init (page reload/deep link)
    // and whenever the shell broadcasts a change while this page is already open.
    _restoreSystemSelection: function (oModel) {
      const sStoredSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (!sStoredSystem) return;
      oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sStoredSystem });
    },

    _onSystemChangedExternally: function () {
      this._refresh();
    },

    onSearch: function () {
      this._refresh();
    },

    // Re-reads sessionStorage and (re)applies the header on every refresh, right before
    // rebind() — instead of only relying on _restoreSystemSelection (onInit) and the
    // systemChanged event to have already set it on this component's model at some earlier
    // point. Verified against a real tenant that relying on those alone isn't reliable here:
    // the header was still missing from the actual $batch sub-request even after the shell's
    // dropdown clearly showed the right system selected and the user manually pressed "Ir" —
    // some FPM/routing timing gap between this nested component's model and the shell's event
    // was dropping it silently. Re-applying synchronously at the one moment that actually
    // matters (right before the request is built) sidesteps that regardless of its cause.
    _refresh: function () {
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      const oModel = this.getView().getModel();
      if (sSystem && oModel) oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sSystem });

      // oTable.getRowBinding().refresh() reaches past the mdc/FE Table's own
      // binding lifecycle and leaves it in an inconsistent state (throws deep
      // inside sap/fe/macros on the next interaction). rebind() is the
      // documented way to force an mdc Table to reload with its current
      // filters/sorters.
      const oTable = this.byId("tbl");
      if (oTable && oTable.rebind) oTable.rebind();
    }
  });
});
