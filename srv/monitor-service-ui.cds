using MonitorService as service from './monitor-service';

annotate service.MessageProcessingLogs with @(
  UI.HeaderInfo: {
    TypeName      : 'Ejecución',
    TypeNamePlural: 'Ejecuciones',
    Title: { Value: MessageGuid }
  },
  UI.SelectionFields: [
    Status,
    IntegrationFlowName,
    SearchId,
    TimePreset,
    CustomFrom,
    CustomTo
  ],
  UI.LineItem: [
    { Value: Status,               Label: 'Estado', Criticality: StatusCriticality },
    { Value: IntegrationFlowName,  Label: 'Artefacto' },
    { Value: LogStart,             Label: 'Inicio' },
    { Value: LogEnd,               Label: 'Fin' },
    { Value: Sender,                Label: 'Emisor' },
    { Value: Receiver,              Label: 'Receptor' },
    { Value: MessageGuid,           Label: 'Message GUID' },
    { Value: CorrelationId,         Label: 'Correlation ID' },
    { Value: ApplicationMessageId,  Label: 'Application Message ID' },
    { Value: LogLevel,              Label: 'Nivel de log' }
  ],
  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'GeneralInformation',
      Label : 'Información general',
      Target: '@UI.FieldGroup#GeneralInformation'
    }
  ],
  UI.FieldGroup #GeneralInformation: {
    Data: [
      { Value: Status,                Criticality: StatusCriticality },
      { Value: IntegrationFlowName },
      { Value: LogStart },
      { Value: LogEnd },
      { Value: Sender },
      { Value: Receiver },
      { Value: CorrelationId },
      { Value: ApplicationMessageId },
      { Value: ApplicationMessageType },
      { Value: PredecessorMessageGuid },
      { Value: LocalComponentName },
      { Value: PreviousComponentName },
      { Value: OriginComponentName },
      { Value: TransactionId },
      { Value: CustomStatus },
      { Value: LogLevel },
      { $Type: 'UI.DataFieldWithUrl', Label: 'Ver en Integration Suite', Value: AlternateWebLink, Url: AlternateWebLink }
    ]
  }
) {
  Status               @title: 'Estado' @Common.ValueListWithFixedValues: true @Common.ValueList: {
    Label: 'Estado',
    CollectionPath: 'StatusValues',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut',      LocalDataProperty: Status, ValueListProperty: 'Code' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'Text' }
    ]
  };
  IntegrationFlowName  @title: 'Artefacto' @Common.ValueList: {
    Label: 'Artefacto',
    CollectionPath: 'Artifacts',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IntegrationFlowName, ValueListProperty: 'Name' }
    ]
  };
  SearchId               @title: 'ID mensaje / correlation';
  TimePreset             @title: 'Periodo';
  CustomFrom             @title: 'Desde';
  CustomTo               @title: 'Hasta';
  ApplicationMessageType @title: 'Tipo de mensaje';
  PredecessorMessageGuid @title: 'Message GUID predecesor';
  LocalComponentName     @title: 'Componente local';
  PreviousComponentName  @title: 'Componente anterior';
  OriginComponentName    @title: 'Componente de origen';
  TransactionId          @title: 'Transaction ID';
  CustomStatus           @title: 'Estado personalizado';
  AlternateWebLink       @title: 'Enlace en Integration Suite';
}

annotate service.Artifacts with @(UI.HeaderInfo: { TypeName: 'Artefacto', TypeNamePlural: 'Artefactos' });
annotate service.Systems with @(UI.HeaderInfo: { TypeName: 'Sistema', TypeNamePlural: 'Sistemas' });
