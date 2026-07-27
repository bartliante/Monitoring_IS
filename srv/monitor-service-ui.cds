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
    { Value: Status,               Label: 'Estado' },
    { Value: IntegrationFlowName,  Label: 'Artefacto' },
    { Value: LogStart,             Label: 'Inicio' },
    { Value: LogEnd,               Label: 'Fin' },
    { Value: Sender,                Label: 'Emisor' },
    { Value: Receiver,              Label: 'Receptor' },
    { Value: MessageGuid,           Label: 'Message GUID' },
    { Value: CorrelationId,         Label: 'Correlation ID' },
    { Value: ApplicationMessageId,  Label: 'Application Message ID' },
    { Value: LogLevel,              Label: 'Nivel de log' }
  ]
) {
  Status               @title: 'Estado';
  IntegrationFlowName  @title: 'Artefacto' @Common.ValueList: {
    Label: 'Artefacto',
    CollectionPath: 'Artifacts',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: IntegrationFlowName, ValueListProperty: 'Name' }
    ]
  };
  SearchId    @title: 'ID mensaje / correlation';
  TimePreset  @title: 'Periodo';
  CustomFrom  @title: 'Desde';
  CustomTo    @title: 'Hasta';
}

annotate service.Artifacts with @(UI.HeaderInfo: { TypeName: 'Artefacto', TypeNamePlural: 'Artefactos' });
annotate service.Systems with @(UI.HeaderInfo: { TypeName: 'Sistema', TypeNamePlural: 'Sistemas' });
