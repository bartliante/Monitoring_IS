sap.ui.define([
  "sap/fe/core/PageController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (PageController, JSONModel, MessageToast, MessageBox) {
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
      this.getView().setModel(new JSONModel({}), "aiSuggestion");

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

      this.getView().getModel("aiSuggestion").setData({});
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

    // Ensures the OData V4 model carries the currently-selected system on its
    // headers before an action call — same robustness reason _callFunction
    // re-reads it from sessionStorage rather than assuming it's still set.
    _applySystemHeader: function (oModel) {
      const sSystem = window.sessionStorage.getItem(SYSTEM_STORAGE_KEY);
      if (sSystem) oModel.changeHttpHeaders({ [SYSTEM_HEADER]: sSystem });
    },

    onAnalyzeWithAI: function () {
      const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
      const oAiModel = this.getView().getModel("aiSuggestion");
      const sMessageGuid = this._sLastMessageGuid;
      if (!sMessageGuid) return;

      const oModel = this.getView().getModel();
      this._applySystemHeader(oModel);

      oAiModel.setData({ busy: true });

      const oOperation = oModel.bindContext("/analyzeError(...)");
      oOperation.setParameter("messageGuid", sMessageGuid);

      oOperation.execute()
        .then(() => {
          const oResult = oOperation.getBoundContext().getObject();
          oAiModel.setData({
            busy: false,
            diagnosis: oResult.Diagnosis,
            filePath: oResult.FilePath,
            currentCode: oResult.CurrentCode,
            proposedCode: oResult.ProposedCode,
            explanation: oResult.Explanation
          });
        })
        .catch(oError => {
          oAiModel.setData({ busy: false });
          MessageBox.error(oError.message || oResourceBundle.getText("fixApplyError"));
        });
    },

    onApplyFix: function () {
      const oResourceBundle = this.getView().getModel("i18n").getResourceBundle();
      const oAiModel = this.getView().getModel("aiSuggestion");
      const sMessageGuid = this._sLastMessageGuid;
      const sFilePath = oAiModel.getProperty("/filePath");
      if (!sMessageGuid || !sFilePath) return;

      const oModel = this.getView().getModel();
      this._applySystemHeader(oModel);

      oAiModel.setProperty("/busy", true);

      const oOperation = oModel.bindContext("/applyFixAndDeploy(...)");
      oOperation.setParameter("messageGuid", sMessageGuid);
      oOperation.setParameter("filePath", sFilePath);
      oOperation.setParameter("proposedCode", oAiModel.getProperty("/proposedCode"));

      oOperation.execute()
        .then(() => {
          const oResult = oOperation.getBoundContext().getObject();
          oAiModel.setProperty("/busy", false);
          if (oResult.Success) {
            MessageToast.show(oResourceBundle.getText("fixApplied", [oResult.TaskId]));
            oAiModel.setData({});
          } else {
            MessageBox.error(oResult.Message || oResourceBundle.getText("fixApplyError"));
          }
        })
        .catch(oError => {
          oAiModel.setProperty("/busy", false);
          MessageBox.error(oError.message || oResourceBundle.getText("fixApplyError"));
        });
    }
  });
});
