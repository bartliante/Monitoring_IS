type Status : String enum {
  COMPLETED;
  FAILED;
  ESCALATED;
  PROCESSING;
  RETRY;
  DISCARDED;
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
  entity MessageProcessingLogs {
    key MessageGuid          : String;
        CorrelationId        : String;
        ApplicationMessageId : String;
        IntegrationFlowName  : String;
        Status               : Status;
        LogLevel             : String;
        LogStart             : DateTime;
        LogEnd               : DateTime;
        Sender               : String;
        Receiver             : String;

        // filter-only fields, rendered as regular filter bar fields by Fiori Elements
        SearchId   : String;
        TimePreset : TimePreset;
        CustomFrom : DateTime;
        CustomTo   : DateTime;
  }

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
