// Verified against the real Message Processing Logs API: these six are the
// complete set of Status values it returns — nothing missing, nothing extra.
type Status : String enum {
  COMPLETED  @Core.Description: 'Completado';
  FAILED     @Core.Description: 'Fallido';
  ESCALATED  @Core.Description: 'Escalado';
  PROCESSING @Core.Description: 'En proceso';
  RETRY      @Core.Description: 'Reintentando';
  DISCARDED  @Core.Description: 'Descartado';
}

// Leave TimePreset unset to use CustomFrom/CustomTo directly instead of a preset.
type TimePreset : String enum {
  LAST_HOUR;
  LAST_24_HOURS;
  LAST_WEEK;
}

/**
 * Monitoring UI service. Stateless — every read reaches out live to the SAP
 * Integration Suite tenant selected via the `x-system-destination` header, or
 * to the BTP Destination service to manage that list of tenants. No entity
 * here is backed by a database.
 */
service MonitorService @(path: '/monitor', requires: 'Monitor') {

  @readonly
  entity Systems {
    key Name        : String;
        DisplayName : String;
        Url         : String;
  }

  @readonly
  entity Artifacts {
    key Id   : String;
        Name : String;
  }

  @readonly
  entity IntegrationPackages {
    key Id   : String;
        Name : String;
  }

  // Iflows contenidos en un paquete — desplegable dependiente de "Paquete" en
  // Diseño de iflow (modo Actualizar). Navegación puntual sobre
  // IntegrationPackages, resuelta con rawGet en monitor-service.js (no CQN,
  // mismo motivo que getAttachments/getErrorTrace).
  function getPackageArtifacts( packageId : String ) returns array of {
    Id      : String;
    Name    : String;
    Version : String;
  };

  // Metadatos de un iflow existente para precargar el formulario de
  // Actualizar. Sender/Receiver son atributos reales de
  // IntegrationDesigntimeArtifacts (verificado contra el tenant real), no
  // hay que parsear el .iflw.
  function getIflowDetails( artifactId : String ) returns {
    Id          : String;
    PackageId   : String;
    Name        : String;
    Description : String;
    Sender      : String;
    Receiver    : String;
  };

  // Backs the fixed-values dropdown for the "Estado" filter (see
  // Status @Common.ValueList in monitor-service-ui.cds) — Fiori Elements needs
  // an actual CollectionPath to render a dropdown, Validation.AllowedValues
  // (auto-derived from the Status enum) alone only drives input validation,
  // not the filter bar's value help. Served from the enum's own
  // @Core.Description in monitor-service.js, so the Spanish text has one
  // source of truth.
  @readonly
  entity StatusValues {
    key Code : String;
        Text : String;
  }

  @readonly
  entity MessageProcessingLogs {
    key MessageGuid            : String;
        CorrelationId          : String;
        ApplicationMessageId   : String;
        ApplicationMessageType : String;
        PredecessorMessageGuid : String;
        IntegrationFlowName    : String;
        Status                 : Status;
        LogLevel               : String;
        LogStart               : DateTime;
        LogEnd                 : DateTime;
        Sender                 : String;
        Receiver               : String;
        CustomStatus           : String;
        TransactionId          : String;
        PreviousComponentName  : String;
        LocalComponentName     : String;
        OriginComponentName    : String;
        AlternateWebLink       : String;

        // drives the traffic-light color of the Status column (see @UI.LineItem
        // in monitor-service-ui.cds) — computed server-side from Status, not a
        // real remote field.
        virtual StatusCriticality : Integer;

        // filter-only fields, rendered as regular filter bar fields by Fiori Elements
        SearchId   : String;
        TimePreset : TimePreset;
        CustomFrom : DateTime;
        CustomTo   : DateTime;
  }

  // Detalle del error: raw text of MessageProcessingLogs('id')/ErrorInformation/$value.
  function getErrorTrace( messageGuid : String ) returns String;

  // Adjuntos: list of MessageProcessingLogs('id')/Attachments plus each one's
  // content (fetched from its media_src), so the UI can render one tab per
  // attachment without a second round-trip per tab.
  function getAttachments( messageGuid : String ) returns array of {
    Id          : String;
    Name        : String;
    ContentType : String;
    Content     : String;
  };

  type AiSuggestion : {
    Diagnosis    : String;
    FilePath     : String;
    CurrentCode  : String;
    ProposedCode : String;
    Explanation  : String;
  }

  // Analiza el error de una ejecución FAILED (traza + adjuntos + contenido del
  // iflow) con Claude y propone una corrección de un único fichero. Efectos:
  // llamada de pago a la API de Anthropic + escritura en la caché en memoria
  // que applyFixAndDeploy necesita después — de ahí que sea action, no function.
  action analyzeError( messageGuid : String ) returns AiSuggestion;

  @requires: 'ConnectionAdmin'
  action applyFixAndDeploy(
    messageGuid  : String,
    filePath     : String,
    proposedCode : String
  ) returns {
    Success : Boolean;
    TaskId  : String;
    Message : String;
  };

  type IflowMode : String enum { CREATE; UPDATE; }
  type AiInputMode : String enum { PROMPT; DOCUMENT; }

  type IflowDesignProposal : {
    Summary  : String;
    Warnings : String;
    Files    : array of {
      Path    : String;
      Preview : String;
    };
    // .iflw completo (no truncado) tras aplicar los cambios propuestos — el
    // frontend lo parsea (BPMNDI) para dibujar un esquema simplificado del
    // flujo antes de confirmar. Ver IflowDesign.controller.js#_buildDiagramSvg.
    Diagram  : LargeString;
  }

  // Analiza el requerimiento (prompt o diseño técnico adjunto) con IA y
  // propone el contenido del iflow a crear/actualizar, sin tocar el tenant
  // todavía (igual que analyzeError frente a applyFixAndDeploy). El resultado
  // se cachea en memoria para que confirmIflowDesign no tenga que repetir la
  // llamada a la IA.
  action designIflow(
    mode               : IflowMode,
    packageId          : String,
    artifactId         : String,
    artifactName       : String,
    description        : String,
    sender             : String,
    receiver           : String,
    aiInputMode        : AiInputMode,
    prompt             : String,
    designDocument     : LargeString,
    designDocumentName : String
  ) returns IflowDesignProposal;

  @requires: 'ConnectionAdmin'
  action confirmIflowDesign( artifactId : String ) returns {
    Success : Boolean;
    TaskId  : String;
    Message : String;
  };

  // Botón "+" junto a "Paquete" en Diseño de iflow (común a Crear/Actualizar).
  // POST /IntegrationPackages con Id/Name/ShortText (verificado contra el
  // tenant real) — Description/Version/etc. quedan con los valores por
  // defecto del tenant, editables después desde Integration Suite.
  @requires: 'ConnectionAdmin'
  action createPackage(
    id        : String,
    name      : String,
    shortText : String
  ) returns IntegrationPackages;

  @requires: 'ConnectionAdmin'
  action createConnection(
    name         : String,
    apiUrl       : String,
    tokenUrl     : String,
    clientId     : String,
    clientSecret : String
  ) returns Systems;

  @requires: 'ConnectionAdmin'
  action deleteConnection( name : String );
}
