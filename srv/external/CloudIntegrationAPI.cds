/**
 * Handwritten shape of the SAP Cloud Integration OData V2 API (Manage Integration Content
 * + Message Processing Logs packages), covering only the fields this app needs.
 * To be replaced/refined via `cds import <tenant>/api/v1/$metadata` once a real tenant is available.
 */
@cds.external
service CloudIntegrationAPI @(path: '/api/v1') {

  @readonly entity MessageProcessingLogs {
    key MessageGuid           : String;
        CorrelationId         : String;
        ApplicationMessageId  : String;
        ApplicationMessageType: String;
        LogStart              : DateTime;
        LogEnd                : DateTime;
        Sender                : String;
        Receiver              : String;
        IntegrationFlowName   : String;
        Status                : String;
        LogLevel              : String;
        ComponentName         : String;
        TransactionId         : String;
        CustomStatus          : String;
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
