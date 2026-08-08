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

  function initialData() {
    return {
      mode: "CREATE",
      modeIndex: 0,
      packages: [],
      packageId: "",
      artifacts: [],
      artifactId: "",
      name: "",
      id: "",
      description: "",
      sender: "",
      receiver: "",
      aiInputMode: "PROMPT",
      aiInputModeIndex: 0,
      prompt: "",
      documentBase64: "",
      documentName: "",
      busy: false,
      proposal: null
    };
  }

  return Controller.extend("monitoringis.shell.controller.IflowDesign", {

    // Just the JSONModel here — this view is a nested XMLView instantiated while the
    // Shell's own root view is still being built, before the Component's manifest
    // models (i18n included) have propagated down to it. Anything touching the i18n
    // resource bundle must wait until a later, user-triggered handler (see
    // _resourceBundle's callers) — never call it from onInit.
    onInit: function () {
      this.getView().setModel(new JSONModel(initialData()), "iflowDesign");

      sap.ui.getCore().getEventBus().subscribe(EVENT_CHANNEL, EVENT_SYSTEM_CHANGED, this._onSystemChangedExternally, this);

      this._loadPackages();
    },

    onExit: function () {
      sap.ui.getCore().getEventBus().unsubscribe(EVENT_CHANNEL, EVENT_SYSTEM_CHANGED, this._onSystemChangedExternally, this);
    },

    // Shell.controller.js publishes this when the system changes from the shared
    // toolbar — same channel/event Monitoring's own ListReportCustom.controller.js
    // subscribes to for the same reason (it, too, has data that was fetched under
    // the previous system's header and won't refetch on its own).
    _onSystemChangedExternally: function () {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/packageId", "");
      oModel.setProperty("/artifacts", []);
      oModel.setProperty("/artifactId", "");
      oModel.setProperty("/id", "");
      oModel.setProperty("/description", "");
      oModel.setProperty("/sender", "");
      oModel.setProperty("/receiver", "");
      oModel.setProperty("/proposal", null);
      this._loadPackages();
    },

    // Deliberately a plain fetch against /monitor/IntegrationPackages (a real OData V4
    // collection, confirmed working via curl) instead of a declarative
    // items="{/IntegrationPackages}" binding on the Select: that binding never actually
    // fired a request in practice — this view toggles visible on/off inside Shell's
    // mainContents rather than being freshly created each time, and whatever that does
    // to the OData V4 model's list-binding lifecycle here, it never reached the network
    // (confirmed empty in the browser's Network tab). A plain fetch(), same pattern as
    // _callFunction below, only depends on sessionStorage + the browser fetch API, so
    // none of that uncertainty applies.
    _loadPackages: function () {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/packages", []);
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (!sSystem) return;

      fetch("/monitor/IntegrationPackages", {
        credentials: "same-origin",
        headers: { [SYSTEM_HEADER]: sSystem }
      }).then(res => {
        if (!res.ok) throw new Error(`IntegrationPackages failed: HTTP ${res.status}`);
        return res.json();
      }).then(oResult => oModel.setProperty("/packages", oResult.value || []))
        .catch(oError => MessageBox.error(oError.message || this._resourceBundle().getText("designError")));
    },

    // Same reasoning as above for getPackageArtifacts/getIflowDetails: they return an
    // array/complex type of an anonymous CDS type (not a real entity), so a plain fetch
    // against the exact verified URL shape is more predictable than guessing the right
    // bindContext incantation for that return shape.
    _callFunction: function (sName, mParams) {
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      const sQuery = Object.keys(mParams)
        .map(sKey => `${sKey}='${String(mParams[sKey]).replace(/'/g, "''")}'`)
        .join(",");
      return fetch(`/monitor/${sName}(${sQuery})`, {
        credentials: "same-origin",
        headers: sSystem ? { [SYSTEM_HEADER]: sSystem } : {}
      }).then(res => {
        if (!res.ok) throw new Error(`${sName} failed: HTTP ${res.status}`);
        return res.json();
      });
    },

    // designIflow/confirmIflowDesign return a named complex type (IflowDesignProposal /
    // the Success-TaskId-Message shape), same as applyFixAndDeploy — bindContext works
    // reliably there, unlike the anonymous-type functions above.
    _applySystemHeader: function () {
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (sSystem) this.getView().getModel().changeHttpHeaders({ [SYSTEM_HEADER]: sSystem });
    },

    _resourceBundle: function () {
      return this.getView().getModel("i18n").getResourceBundle();
    },

    // The ID actually sent to the backend: for Crear it's the (derived, editable) /id
    // field; for Actualizar it's whichever existing iflow was picked in the Select.
    _currentArtifactId: function () {
      const oModel = this.getView().getModel("iflowDesign");
      return oModel.getProperty("/mode") === "CREATE" ? oModel.getProperty("/id") : oModel.getProperty("/artifactId");
    },

    onModeSelect: function (oEvent) {
      const iIndex = oEvent.getParameter("selectedIndex");
      const bIsUpdate = iIndex === 1;
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/mode", bIsUpdate ? "UPDATE" : "CREATE");
      oModel.setProperty("/modeIndex", iIndex);
      oModel.setProperty("/proposal", null);
      oModel.setProperty("/name", "");
      oModel.setProperty("/id", "");
      oModel.setProperty("/description", "");
      oModel.setProperty("/sender", "");
      oModel.setProperty("/receiver", "");
      oModel.setProperty("/artifactId", "");
      oModel.setProperty("/artifacts", []);

      if (bIsUpdate && oModel.getProperty("/packageId")) this._loadPackageArtifacts(oModel.getProperty("/packageId"));
    },

    onPackageChange: function (oEvent) {
      const sPackageId = oEvent.getParameter("selectedItem") ? oEvent.getParameter("selectedItem").getKey() : oEvent.getSource().getSelectedKey();
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/packageId", sPackageId);
      oModel.setProperty("/proposal", null);
      if (oModel.getProperty("/mode") === "UPDATE") this._loadPackageArtifacts(sPackageId);
    },

    _loadPackageArtifacts: function (sPackageId) {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/artifacts", []);
      oModel.setProperty("/artifactId", "");
      oModel.setProperty("/id", "");
      oModel.setProperty("/description", "");
      oModel.setProperty("/sender", "");
      oModel.setProperty("/receiver", "");
      if (!sPackageId) return;

      this._callFunction("getPackageArtifacts", { packageId: sPackageId })
        .then(oResult => oModel.setProperty("/artifacts", oResult.value || []))
        .catch(oError => MessageBox.error(oError.message || this._resourceBundle().getText("designError")));
    },

    onArtifactChange: function (oEvent) {
      const sArtifactId = oEvent.getParameter("selectedItem") ? oEvent.getParameter("selectedItem").getKey() : oEvent.getSource().getSelectedKey();
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/artifactId", sArtifactId);
      oModel.setProperty("/proposal", null);
      if (!sArtifactId) return;

      this._callFunction("getIflowDetails", { artifactId: sArtifactId })
        .then(oResult => {
          oModel.setProperty("/id", oResult.Id || sArtifactId);
          oModel.setProperty("/name", oResult.Name || "");
          oModel.setProperty("/description", oResult.Description || "");
          oModel.setProperty("/sender", oResult.Sender || "");
          oModel.setProperty("/receiver", oResult.Receiver || "");
        })
        .catch(oError => MessageBox.error(oError.message || this._resourceBundle().getText("designError")));
    },

    onNameLiveChange: function (oEvent) {
      const sName = oEvent.getParameter("value");
      this.getView().getModel("iflowDesign").setProperty("/id", sName.trim().replace(/\s+/g, "_"));
    },

    onAiInputModeSelect: function (oEvent) {
      const iIndex = oEvent.getParameter("selectedIndex");
      const sMode = iIndex === 1 ? "DOCUMENT" : iIndex === 2 ? "TEMPLATE" : "PROMPT";
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/aiInputMode", sMode);
      oModel.setProperty("/aiInputModeIndex", iIndex);
    },

    onDocumentSelected: function (oEvent) {
      const oFile = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      const oModel = this.getView().getModel("iflowDesign");
      if (!oFile) {
        oModel.setProperty("/documentBase64", "");
        oModel.setProperty("/documentName", "");
        return;
      }
      const oReader = new FileReader();
      oReader.onload = () => {
        const sBase64 = oReader.result.split(",").pop();
        oModel.setProperty("/documentBase64", sBase64);
        oModel.setProperty("/documentName", oFile.name);
      };
      oReader.readAsDataURL(oFile);
    },

    onSubmit: function () {
      const oResourceBundle = this._resourceBundle();
      const oModel = this.getView().getModel("iflowDesign");
      const sMode = oModel.getProperty("/mode");
      const sArtifactId = this._currentArtifactId();
      const sPackageId = oModel.getProperty("/packageId");
      const sName = oModel.getProperty("/name");
      const sAiInputMode = oModel.getProperty("/aiInputMode");

      if (!sPackageId || !sArtifactId || (sMode === "CREATE" && !sName)) {
        MessageBox.error(oResourceBundle.getText("missingRequiredFields"));
        return;
      }
      if (sAiInputMode === "PROMPT" && !oModel.getProperty("/prompt")) {
        MessageBox.error(oResourceBundle.getText("missingRequirements"));
        return;
      }
      if (sAiInputMode === "DOCUMENT" && !oModel.getProperty("/documentBase64")) {
        MessageBox.error(oResourceBundle.getText("missingRequirements"));
        return;
      }

      this._applySystemHeader();
      oModel.setProperty("/busy", true);
      oModel.setProperty("/proposal", null);

      const oOperation = this.getView().getModel().bindContext("/designIflow(...)");
      oOperation.setParameter("mode", sMode);
      oOperation.setParameter("packageId", sPackageId);
      oOperation.setParameter("artifactId", sArtifactId);
      oOperation.setParameter("artifactName", sName);
      oOperation.setParameter("description", oModel.getProperty("/description"));
      oOperation.setParameter("sender", oModel.getProperty("/sender"));
      oOperation.setParameter("receiver", oModel.getProperty("/receiver"));
      oOperation.setParameter("aiInputMode", sAiInputMode);
      oOperation.setParameter("prompt", oModel.getProperty("/prompt"));
      oOperation.setParameter("designDocument", oModel.getProperty("/documentBase64"));
      oOperation.setParameter("designDocumentName", oModel.getProperty("/documentName"));

      oOperation.execute()
        .then(() => {
          const oResult = oOperation.getBoundContext().getObject();
          oModel.setProperty("/busy", false);
          oModel.setProperty("/proposal", oResult);
        })
        .catch(oError => {
          oModel.setProperty("/busy", false);
          MessageBox.error(oError.message || oResourceBundle.getText("designError"));
        });
    },

    onConfirm: function () {
      const oResourceBundle = this._resourceBundle();
      const oModel = this.getView().getModel("iflowDesign");
      const sArtifactId = this._currentArtifactId();
      if (!sArtifactId) return;

      this._applySystemHeader();
      oModel.setProperty("/busy", true);

      const oOperation = this.getView().getModel().bindContext("/confirmIflowDesign(...)");
      oOperation.setParameter("artifactId", sArtifactId);

      oOperation.execute()
        .then(() => {
          const oResult = oOperation.getBoundContext().getObject();
          oModel.setProperty("/busy", false);
          if (oResult.Success) {
            MessageToast.show(oResourceBundle.getText("iflowDesignConfirmed", [oResult.TaskId]));
            oModel.setProperty("/proposal", null);
          } else {
            MessageBox.error(oResult.Message || oResourceBundle.getText("designError"));
          }
        })
        .catch(oError => {
          oModel.setProperty("/busy", false);
          MessageBox.error(oError.message || oResourceBundle.getText("designError"));
        });
    },

    onDiscardProposal: function () {
      this.getView().getModel("iflowDesign").setProperty("/proposal", null);
    }
  });
});
