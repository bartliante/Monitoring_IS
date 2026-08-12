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
      proposal: null,
      diagramSvg: "",
      // Estado del despliegue tras confirmar — se actualiza solo vía polling (ver
      // _pollDeployStatus), sin bloquear el resto de la app mientras tanto.
      deployStatus: { visible: false, type: "Information", text: "" }
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
      if (this._iDeployPollTimeout) clearTimeout(this._iDeployPollTimeout);
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
      oModel.setProperty("/diagramSvg", "");
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
      }).then(oResult => {
        const aPackages = oResult.value || [];
        oModel.setProperty("/packages", aPackages);
        // Same forceSelection=true gotcha as artifactSelect (see _loadPackageArtifacts):
        // Select auto-picks the first package visually without firing "change", so keep
        // the model in sync with whatever it ends up showing.
        if (aPackages.length && !oModel.getProperty("/packageId")) this._selectPackage(aPackages[0].Id);
      }).catch(oError => MessageBox.error(oError.message || this._resourceBundle().getText("designError")));
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
      oModel.setProperty("/diagramSvg", "");
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
      this._selectPackage(sPackageId);
    },

    _selectPackage: function (sPackageId) {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/packageId", sPackageId);
      oModel.setProperty("/proposal", null);
      oModel.setProperty("/diagramSvg", "");
      if (oModel.getProperty("/mode") === "UPDATE") this._loadPackageArtifacts(sPackageId);
    },

    // "+" junto a Paquete — común a Crear/Actualizar.
    onNewPackage: function () {
      if (!this._pNewPackageDialog) {
        this._pNewPackageDialog = this.loadFragment({ name: "monitoringis.shell.fragment.NewPackageDialog" });
      }
      this._pNewPackageDialog.then(oDialog => oDialog.open());
    },

    onPackageNameLiveChange: function (oEvent) {
      const sName = oEvent.getParameter("value");
      this.byId("packageTechnicalName").setValue(sName.replace(/[^a-zA-Z0-9]/g, ""));
    },

    onCreatePackageConfirm: function () {
      const oResourceBundle = this._resourceBundle();
      const sName = this.byId("packageName").getValue().trim();
      const sTechnicalName = this.byId("packageTechnicalName").getValue().trim();
      const sShortText = this.byId("packageShortText").getValue().trim();

      if (!sName || !sTechnicalName || !sShortText) {
        MessageBox.error(oResourceBundle.getText("allFieldsRequired"));
        return;
      }

      this._applySystemHeader();

      const oOperation = this.getView().getModel().bindContext("/createPackage(...)");
      oOperation.setParameter("id", sTechnicalName);
      oOperation.setParameter("name", sName);
      oOperation.setParameter("shortText", sShortText);

      oOperation.execute()
        .then(() => {
          const oResult = oOperation.getBoundContext().getObject();
          MessageToast.show(oResourceBundle.getText("packageCreated", [oResult.Name]));
          this.byId("newPackageDialog").close();
          this._resetPackageDialogFields();
          this._loadPackages();
          this._selectPackage(oResult.Id);
        })
        .catch(oError => {
          MessageBox.error(oError.message || oResourceBundle.getText("designError"));
        });
    },

    onCreatePackageCancel: function () {
      this.byId("newPackageDialog").close();
      this._resetPackageDialogFields();
    },

    _resetPackageDialogFields: function () {
      ["packageName", "packageTechnicalName"].forEach(sId => this.byId(sId).setValue(""));
      this.byId("packageShortText").setValue("");
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
        .then(oResult => {
          const aArtifacts = oResult.value || [];
          oModel.setProperty("/artifacts", aArtifacts);
          // sap.m.Select defaults to forceSelection=true: with a single (or, after
          // this list loads, the first) item it selects it visually on its own,
          // but that auto-selection never fires "change" — only a real click does.
          // Without this, a package with exactly one iflow left /artifactId (and
          // everything derived from it) empty forever despite looking selected.
          if (aArtifacts.length) this._selectArtifact(aArtifacts[0].Id);
        })
        .catch(oError => MessageBox.error(oError.message || this._resourceBundle().getText("designError")));
    },

    onArtifactChange: function (oEvent) {
      const sArtifactId = oEvent.getParameter("selectedItem") ? oEvent.getParameter("selectedItem").getKey() : oEvent.getSource().getSelectedKey();
      this._selectArtifact(sArtifactId);
    },

    _selectArtifact: function (sArtifactId) {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/artifactId", sArtifactId);
      oModel.setProperty("/proposal", null);
      oModel.setProperty("/diagramSvg", "");
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
      // DOCUMENT y TEMPLATE comparten /documentBase64 (dos FileUploader distintos, mismo
      // modelo) — sin esto, cambiar de modo sin volver a adjuntar reenviaría el fichero
      // anterior (p. ej. un PDF) como si fuera del tipo nuevo. Se limpia también el propio
      // control para que no siga mostrando el nombre del fichero anterior.
      oModel.setProperty("/documentBase64", "");
      oModel.setProperty("/documentName", "");
      const oDocUploader = this.byId("designDocumentUploader");
      const oTemplateUploader = this.byId("designTemplateUploader");
      if (oDocUploader) oDocUploader.clear();
      if (oTemplateUploader) oTemplateUploader.clear();
    },

    onDownloadTemplate: function () {
      // Ruta servida directamente por server.js (fuera del mount OData /monitor) con
      // Content-Disposition: attachment — un simple window.open ya dispara la descarga.
      window.open("/templates/plantilla-diseno-iflow.xlsx", "_blank");
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

      if (!sPackageId) {
        MessageBox.error(oResourceBundle.getText("missingPackage"));
        return;
      }
      if (sMode === "CREATE" && !sName) {
        MessageBox.error(oResourceBundle.getText("missingRequiredFields"));
        return;
      }
      if (sMode === "UPDATE" && !sArtifactId) {
        MessageBox.error(oResourceBundle.getText("missingArtifact"));
        return;
      }
      if (sAiInputMode === "PROMPT" && !oModel.getProperty("/prompt")) {
        MessageBox.error(oResourceBundle.getText("missingRequirements"));
        return;
      }
      if ((sAiInputMode === "DOCUMENT" || sAiInputMode === "TEMPLATE") && !oModel.getProperty("/documentBase64")) {
        MessageBox.error(oResourceBundle.getText("missingRequirements"));
        return;
      }

      this._applySystemHeader();
      if (this._iDeployPollTimeout) clearTimeout(this._iDeployPollTimeout);
      oModel.setProperty("/busy", true);
      oModel.setProperty("/proposal", null);
      oModel.setProperty("/diagramSvg", "");
      oModel.setProperty("/deployStatus", { visible: false, type: "Information", text: "" });

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
          oModel.setProperty("/diagramSvg", this._buildDiagramSvg(oResult.Diagram));
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
            oModel.setProperty("/diagramSvg", "");
            this._pollDeployStatus(sArtifactId, 0);
          } else {
            MessageBox.error(oResult.Message || oResourceBundle.getText("designError"));
          }
        })
        .catch(oError => {
          oModel.setProperty("/busy", false);
          MessageBox.error(oError.message || oResourceBundle.getText("designError"));
        });
    },

    // El deploy real en Cloud Integration es asíncrono — en vez de bloquear la app
    // esperando, se lanza este polling en background (cada 6s, hasta 20 intentos ≈ 2 min) y
    // se actualiza un MessageStrip propio cuando el estado deja de ser STARTING. El usuario
    // puede seguir usando el resto de la app mientras tanto; si navega fuera de esta vista
    // antes de que termine, el aviso se pierde (tendría que volver a "Actualizar" ese iflow
    // para comprobar el estado) — contrapartida aceptada frente a bloquear la UI.
    _pollDeployStatus: function (sArtifactId, iAttempt) {
      const oResourceBundle = this._resourceBundle();
      const oModel = this.getView().getModel("iflowDesign");
      const MAX_ATTEMPTS = 20;
      const POLL_INTERVAL_MS = 6000;

      oModel.setProperty("/deployStatus", {
        visible: true,
        type: "Information",
        text: oResourceBundle.getText("deployStatusPolling", [sArtifactId])
      });

      this._callFunction("getDeployStatus", { artifactId: sArtifactId })
        .then(oResult => {
          if (oResult.Status === "STARTED") {
            oModel.setProperty("/deployStatus", {
              visible: true,
              type: "Success",
              text: oResourceBundle.getText("deployStatusStarted", [sArtifactId])
            });
            return;
          }
          if (oResult.Status === "ERROR") {
            const sDetail = oResult.ErrorMessage || oResourceBundle.getText("deployStatusErrorNoDetail");
            oModel.setProperty("/deployStatus", {
              visible: true,
              type: "Error",
              text: oResourceBundle.getText("deployStatusError", [sArtifactId, sDetail])
            });
            return;
          }
          // Sigue STARTING (o cualquier otro estado transitorio) — reintenta si queda margen.
          if (iAttempt + 1 >= MAX_ATTEMPTS) {
            oModel.setProperty("/deployStatus", {
              visible: true,
              type: "Warning",
              text: oResourceBundle.getText("deployStatusTimeout", [sArtifactId])
            });
            return;
          }
          this._iDeployPollTimeout = setTimeout(() => this._pollDeployStatus(sArtifactId, iAttempt + 1), POLL_INTERVAL_MS);
        })
        .catch(oError => {
          // Un fallo puntual de red al consultar el estado no debe cortar el polling —
          // reintenta igual que si siguiera en STARTING, hasta agotar los intentos.
          if (iAttempt + 1 >= MAX_ATTEMPTS) {
            oModel.setProperty("/deployStatus", {
              visible: true,
              type: "Warning",
              text: oError.message || oResourceBundle.getText("deployStatusTimeout", [sArtifactId])
            });
            return;
          }
          this._iDeployPollTimeout = setTimeout(() => this._pollDeployStatus(sArtifactId, iAttempt + 1), POLL_INTERVAL_MS);
        });
    },

    onDiscardProposal: function () {
      const oModel = this.getView().getModel("iflowDesign");
      oModel.setProperty("/proposal", null);
      oModel.setProperty("/diagramSvg", "");
    },

    // Builds a simplified SVG schema of the iflow directly from the .iflw's own BPMNDI
    // section (the same shape/edge coordinates SAP's graphical editor uses) — there's no
    // public way to embed that real editor, and the proposed iflow doesn't exist as a
    // real artifact yet anyway (only after confirming), so this draws our own. Parsing
    // happens here in the browser (native DOMParser) rather than in the backend so no new
    // XML-parsing dependency is needed anywhere.
    // getElementsByTagName on an XML document matches the LITERAL tagName including its
    // namespace prefix (e.g. "bpmndi:BPMNShape", "dc:Bounds") — it does NOT match by
    // localName. Since the exact prefixes are only a convention (bpmn2/bpmndi/di/dc/ifl),
    // not something to hard-code, every lookup below goes through this helper instead of
    // calling getElementsByTagName with an unprefixed name directly.
    _byLocalName: function (oRoot, sName) {
      return Array.prototype.filter.call(oRoot.getElementsByTagName("*"), oEl => oEl.localName === sName);
    },

    _buildDiagramSvg: function (sFlowXml) {
      if (!sFlowXml) return "";
      try {
        const oDoc = new DOMParser().parseFromString(sFlowXml, "application/xml");
        if (this._byLocalName(oDoc, "parsererror").length) return "";

        const mElements = {};
        Array.prototype.forEach.call(oDoc.getElementsByTagName("*"), oEl => {
          const sId = oEl.getAttribute("id");
          if (!sId) return;
          let sActivityType = "";
          this._byLocalName(oEl, "property").forEach(oProp => {
            const oKey = this._byLocalName(oProp, "key")[0];
            const oValue = this._byLocalName(oProp, "value")[0];
            if (oKey && (oKey.textContent === "activityType" || oKey.textContent === "ComponentType") && oValue && oValue.textContent) {
              sActivityType = oValue.textContent;
            }
          });
          mElements[sId] = { name: oEl.getAttribute("name") || "", tag: oEl.localName, activityType: sActivityType };
        });

        const fCategoryFor = sTag => {
          if (sTag === "startEvent") return "start";
          if (sTag === "endEvent") return "end";
          if (sTag === "exclusiveGateway" || sTag === "parallelGateway") return "gateway";
          if (sTag === "participant") return "participant";
          return "step";
        };

        const aShapes = [];
        this._byLocalName(oDoc, "BPMNShape").forEach(oShape => {
          const sRef = oShape.getAttribute("bpmnElement");
          const oInfo = mElements[sRef];
          const oBounds = this._byLocalName(oShape, "Bounds")[0];
          if (!oInfo || !oBounds) return;
          aShapes.push({
            id: sRef,
            name: oInfo.name || oInfo.activityType || sRef,
            subLabel: oInfo.name ? oInfo.activityType : "",
            category: fCategoryFor(oInfo.tag),
            x: parseFloat(oBounds.getAttribute("x")),
            y: parseFloat(oBounds.getAttribute("y")),
            width: parseFloat(oBounds.getAttribute("width")),
            height: parseFloat(oBounds.getAttribute("height"))
          });
        });

        const aEdges = [];
        this._byLocalName(oDoc, "BPMNEdge").forEach(oEdge => {
          const sRef = oEdge.getAttribute("bpmnElement");
          const oInfo = mElements[sRef];
          const aPoints = this._byLocalName(oEdge, "waypoint").map(oWp => ({
            x: parseFloat(oWp.getAttribute("x")),
            y: parseFloat(oWp.getAttribute("y"))
          }));
          if (!aPoints.length) return;
          aEdges.push({
            id: sRef,
            name: oInfo ? oInfo.name : "",
            category: oInfo && oInfo.tag === "messageFlow" ? "message" : "sequence",
            points: aPoints
          });
        });

        return this._renderDiagramSvg(aShapes, aEdges);
      } catch (oError) {
        return "";
      }
    },

    _renderDiagramSvg: function (aShapes, aEdges) {
      if (!aShapes.length) return "";

      const PAD = 20;
      const minX = Math.min.apply(null, aShapes.map(s => s.x)) - PAD;
      const minY = Math.min.apply(null, aShapes.map(s => s.y)) - PAD;
      const maxX = Math.max.apply(null, aShapes.map(s => s.x + s.width)) + PAD;
      const maxY = Math.max.apply(null, aShapes.map(s => s.y + s.height)) + PAD;
      const width = maxX - minX;
      const height = maxY - minY;

      const STYLES = {
        start: { fill: "#e8f5e9", stroke: "#43a047" },
        end: { fill: "#ffebee", stroke: "#e53935" },
        gateway: { fill: "#fff8e1", stroke: "#f9a825" },
        participant: { fill: "#f5f5f5", stroke: "#bdbdbd" },
        step: { fill: "#e3f2fd", stroke: "#1e88e5" }
      };
      const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

      let sSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}" `
        + `width="${width}" height="${height}" style="max-width:100%;font-family:sans-serif;">`
        + `<defs><marker id="diagArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">`
        + `<path d="M0,0 L6,3 L0,6 Z" fill="#888"/></marker></defs>`;

      aShapes.filter(s => s.category === "participant").forEach(s => {
        const st = STYLES.participant;
        sSvg += `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${st.fill}" stroke="${st.stroke}"/>`
          + `<text x="${s.x + 6}" y="${s.y + 14}" font-size="11" fill="#616161">${esc(s.name)}</text>`;
      });

      aEdges.forEach(e => {
        const sPoints = e.points.map(p => `${p.x},${p.y}`).join(" ");
        const sDash = e.category === "message" ? 'stroke-dasharray="4 3"' : "";
        sSvg += `<polyline points="${sPoints}" fill="none" stroke="#888" stroke-width="1.5" ${sDash} marker-end="url(#diagArrow)"/>`;
        if (e.name) {
          const oMid = e.points[Math.floor(e.points.length / 2)];
          sSvg += `<text x="${oMid.x}" y="${oMid.y - 6}" font-size="10" fill="#555">${esc(e.name)}</text>`;
        }
      });

      aShapes.filter(s => s.category !== "participant").forEach(s => {
        const st = STYLES[s.category] || STYLES.step;
        const cx = s.x + s.width / 2;
        const cy = s.y + s.height / 2;
        if (s.category === "start" || s.category === "end") {
          sSvg += `<circle cx="${cx}" cy="${cy}" r="${Math.min(s.width, s.height) / 2}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"/>`;
        } else if (s.category === "gateway") {
          sSvg += `<polygon points="${cx},${s.y} ${s.x + s.width},${cy} ${cx},${s.y + s.height} ${s.x},${cy}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"/>`;
        } else {
          sSvg += `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.5" rx="6"/>`;
        }
        sSvg += `<text x="${cx}" y="${cy + (s.subLabel ? -2 : 4)}" font-size="10" text-anchor="middle" fill="#333">${esc(s.name)}</text>`;
        if (s.subLabel) sSvg += `<text x="${cx}" y="${cy + 11}" font-size="8" text-anchor="middle" fill="#777">${esc(s.subLabel)}</text>`;
      });

      sSvg += "</svg>";
      return sSvg;
    }
  });
});
