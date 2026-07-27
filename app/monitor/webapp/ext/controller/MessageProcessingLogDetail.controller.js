sap.ui.define([
  "sap/fe/core/PageController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast"
], function (PageController, JSONModel, MessageToast) {
  "use strict";

  const SYSTEM_STORAGE_KEY = "monitoringIS.system";
  const SYSTEM_HEADER = "x-system-destination";

  // sap.fe.macros building blocks (the Form used for "Información general")
  // need the page hosted by a controller extending sap.fe.core.PageController,
  // same reason as the list report's controller.
  return PageController.extend("monitoringis.monitor.ext.controller.MessageProcessingLogDetail", {

    onInit: function () {
      PageController.prototype.onInit.apply(this, arguments);

      this.getView().setModel(new JSONModel({ text: "" }), "errorTrace");
      this.getView().setModel(new JSONModel([]), "attachments");

      this._sLastMessageGuid = null;
      this.getView().attachModelContextChange(this._onContextChange, this);
    },

    _onContextChange: function () {
      const oContext = this.getView().getBindingContext();
      if (!oContext) return;

      const sMessageGuid = oContext.getProperty("MessageGuid");
      const sStatus = oContext.getProperty("Status");
      if (!sMessageGuid || sMessageGuid === this._sLastMessageGuid) return;
      this._sLastMessageGuid = sMessageGuid;

      this._loadErrorTrace(sMessageGuid, sStatus);
      this._loadAttachments(sMessageGuid);
    },

    // Plain fetch() against the same OData V4 service the page's own model
    // uses, rather than the model's action/function-binding APIs: these two
    // functions return either a plain string or a collection of an anonymous
    // type (not an entity), and a raw call to the exact URL shape already
    // verified against the real tenant is more predictable than guessing the
    // right bindContext/bindList incantation for that return shape.
    _callFunction: function (sName, sMessageGuid) {
      const sLiteral = "'" + String(sMessageGuid).replace(/'/g, "''") + "'";
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      return fetch(`/monitor/${sName}(messageGuid=${sLiteral})`, {
        credentials: "same-origin",
        headers: sSystem ? { [SYSTEM_HEADER]: sSystem } : {}
      }).then(res => {
        if (!res.ok) throw new Error(`${sName} failed: HTTP ${res.status}`);
        return res.json();
      });
    },

    _loadErrorTrace: function (sMessageGuid, sStatus) {
      const oErrorModel = this.getView().getModel("errorTrace");
      oErrorModel.setProperty("/text", "");
      if (sStatus !== "FAILED") return;

      this._callFunction("getErrorTrace", sMessageGuid)
        .then(oResult => oErrorModel.setProperty("/text", oResult.value || ""))
        .catch(oError => oErrorModel.setProperty("/text", oError.message || ""));
    },

    _loadAttachments: function (sMessageGuid) {
      const oAttachmentsModel = this.getView().getModel("attachments");
      oAttachmentsModel.setData([]);

      this._callFunction("getAttachments", sMessageGuid)
        .then(oResult => oAttachmentsModel.setData(oResult.value || []))
        .catch(() => oAttachmentsModel.setData([]));
    },

    onAnalyzeWithAI: function () {
      MessageToast.show(this.getView().getModel("i18n").getResourceBundle().getText("aiFeatureNotImplemented"));
    }
  });
});
