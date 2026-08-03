sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  const SYSTEM_STORAGE_KEY = "monitoringIS.system";
  const SYSTEM_HEADER = "x-system-destination";
  const EVENT_CHANNEL = "monitoringIS";
  const EVENT_SYSTEM_CHANGED = "systemChanged";

  return Controller.extend("monitoringis.shell.controller.Shell", {

    onInit: function () {
      this.getView().setModel(new JSONModel({ menuKey: "monitoring" }), "shellView");
      this._restoreSystemSelection();
    },

    onToggleSideNav: function () {
      const oToolPage = this.byId("toolPage");
      oToolPage.setSideExpanded(!oToolPage.getSideExpanded());
    },

    onMenuItemSelect: function (oEvent) {
      const sKey = oEvent.getParameter("item").getKey();
      this.getView().getModel("shellView").setProperty("/menuKey", sKey);
    },

    _restoreSystemSelection: function () {
      const sStoredSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (!sStoredSystem) return;

      const oModel = this.getView().getModel();
      oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sStoredSystem });

      const oSelect = this.byId("systemSelect");
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

      this.getView().getModel().changeHttpHeaders({ [SYSTEM_HEADER]: sSystem });
      window.sessionStorage.setItem(SYSTEM_STORAGE_KEY, sSystem);

      // monitoringis.monitor vive en un componente anidado con su propia
      // instancia de modelo OData: no comparte el changeHttpHeaders de arriba,
      // así que se le avisa por EventBus para que aplique el mismo header en caliente.
      sap.ui.getCore().getEventBus().publish(EVENT_CHANNEL, EVENT_SYSTEM_CHANGED, { system: sSystem });
    },

    onNewConnection: function () {
      if (!this._pNewConnectionDialog) {
        this._pNewConnectionDialog = this.loadFragment({
          name: "monitoringis.shell.fragment.NewConnectionDialog"
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
