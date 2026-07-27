/**
 * Shape of the SAP Cloud Integration OData V2 API (Manage Integration Content +
 * Message Processing Logs packages), covering only the fields this app needs.
 * Field names for MessageProcessingLogs cross-checked against a real tenant's
 * /api/v1/$metadata (there is no plain "ComponentName" — it's split into
 * PreviousComponentName/LocalComponentName/OriginComponentName).
 */
@cds.external
service CloudIntegrationAPI @(path: '/api/v1') {

  @readonly entity MessageProcessingLogs {
    key MessageGuid            : String;
        CorrelationId          : String;
        ApplicationMessageId   : String;
        ApplicationMessageType : String;
        PredecessorMessageGuid : String;
        LogStart               : DateTime;
        LogEnd                 : DateTime;
        Sender                 : String;
        Receiver               : String;
        IntegrationFlowName    : String;
        Status                 : String;
        LogLevel               : String;
        CustomStatus           : String;
        TransactionId          : String;
        PreviousComponentName  : String;
        LocalComponentName     : String;
        OriginComponentName    : String;
        AlternateWebLink       : String;
  }

  @readonly entity IntegrationRuntimeArtifacts {
    key Id         : String;
        Version    : String;
        Name       : String;
        Type       : String;
        DeployedBy : String;
        DeployedOn : DateTime;
        Status     : String;
  }
}
