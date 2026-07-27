sap.ui.define([
  "sap/fe/core/PageController",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (PageController, MessageToast, MessageBox) {
  "use strict";

  const SYSTEM_STORAGE_KEY = "monitoringIS.system";
  const SYSTEM_HEADER = "x-system-destination";

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

    _restoreSystemSelection: function (oModel) {
      const sStoredSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (!sStoredSystem) return;
      oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sStoredSystem });

      const oSelect = this.byId("systemSelect");
      if (!oSelect) return;
      const oItemsBinding = oSelect.getBinding("items");
      if (oItemsBinding && oItemsBinding.getContexts().length) {
        oSelect.setSelectedKey(sStoredSystem);
      } else if (oItemsBinding) {
        oItemsBinding.attachEventOnce("dataReceived", () => oSelect.setSelectedKey(sStoredSystem));
      }
    },

    onSystemChange: function (oEvent) {
      const sSystem = oEvent.getParameter("selectedItem")
        ? oEvent.getParameter("selectedItem").getKey()
        : oEvent.getSource().getSelectedKey();

      const oModel = this.getView().getModel();
      if (!oModel) return;
      oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sSystem });
      window.sessionStorage.setItem(SYSTEM_STORAGE_KEY, sSystem);

      this._refresh();
    },

    onSearch: function () {
      this._refresh();
    },

    _refresh: function () {
      // oTable.getRowBinding().refresh() reaches past the mdc/FE Table's own
      // binding lifecycle and leaves it in an inconsistent state (throws deep
      // inside sap/fe/macros on the next interaction). rebind() is the
      // documented way to force an mdc Table to reload with its current
      // filters/sorters.
      const oTable = this.byId("tbl");
      if (oTable && oTable.rebind) oTable.rebind();
    },

    onNewConnection: function () {
      if (!this._pNewConnectionDialog) {
        this._pNewConnectionDialog = this.loadFragment({
          name: "monitoringis.monitor.ext.fragment.NewConnectionDialog"
        });
      }
      this._pNewConnectionDialog.then(function (oDialog) {
        oDialog.open();
      });
    },

    onCreateConnectionConfirm: function () {
      const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
      const mFields = {
        name: this.byId("connName").getValue().trim(),
        apiUrl: this.byId("connApiUrl").getValue().trim(),
        tokenUrl: this.byId("connTokenUrl").getValue().trim(),
        clientId: this.byId("connClientId").getValue().trim(),
        clientSecret: this.byId("connClientSecret").getValue()
      };

      if (Object.values(mFields).some(v => !v)) {
        MessageBox.error(oResourceBundle.getText("allFieldsRequired"));
        return;
      }

      const oModel = this.getView().getModel();
      const oOperation = oModel.bindContext("/createConnection(...)");
      oOperation.setParameter("name", mFields.name);
      oOperation.setParameter("apiUrl", mFields.apiUrl);
      oOperation.setParameter("tokenUrl", mFields.tokenUrl);
      oOperation.setParameter("clientId", mFields.clientId);
      oOperation.setParameter("clientSecret", mFields.clientSecret);

      oOperation.execute()
        .then(() => {
          MessageToast.show(oResourceBundle.getText("connectionCreated"));
          this.byId("newConnectionDialog").close();
          this._resetDialogFields();
          this.byId("systemSelect").getBinding("items").refresh();
        })
        .catch(oError => {
          MessageBox.error(oError.message || oError.toString());
        });
    },

    onCreateConnectionCancel: function () {
      this.byId("newConnectionDialog").close();
      this._resetDialogFields();
    },

    _resetDialogFields: function () {
      ["connName", "connApiUrl", "connTokenUrl", "connClientId", "connClientSecret"].forEach(sId => {
        const oControl = this.byId(sId);
        if (oControl) oControl.setValue("");
      });
    }
  });
});
