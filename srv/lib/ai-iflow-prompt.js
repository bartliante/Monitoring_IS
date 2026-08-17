// Shared between AI providers (ai-iflow-claude.js / ai-iflow-gemini.js): the
// expected output shape and the system/user prompt content for "Diseño de
// iflow" (Crear/Actualizar), same role ai-fix-prompt.js plays for the "IA -
// Sugerencia de corrección" flow. Unlike that flow (fixes exactly one file),
// this one can touch several files at once — the .iflw plus any scripts it
// adds — since building/extending a flow is rarely a single-file change.

const { serializeFiles } = require('./ai-fix-prompt')
const { selectRelevantComponents, selectComponentsByIds } = require('./ai-iflow-components')

const IFLOW_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Resumen en español de lo que se ha construido o modificado en el iflow' },
    warnings: { type: 'string', description: 'Advertencias o limitaciones del resultado (cadena vacía si no hay ninguna)' },
    files: {
      type: 'array',
      description: 'Ficheros del ZIP del iflow a crear o sobrescribir con su contenido completo',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta exacta dentro del ZIP (una de las ya dadas, o una ruta nueva bajo src/main/resources/script/ o src/main/resources/mapping/ para un fichero nuevo)' },
          content: { type: 'string', description: 'Contenido COMPLETO del fichero ya corregido/creado, no un diff' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'warnings', 'files'],
  additionalProperties: false
}

const BASE_RULES = `Reglas estrictas:
- "path" debe ser exactamente una de las rutas de fichero ya dadas, o una ruta nueva razonable bajo \
src/main/resources/script/ (Groovy/JavaScript) o src/main/resources/mapping/ si el flujo necesita un \
componente de script/mapping que no existía, o src/main/resources/parameters.prop / \
src/main/resources/parameters.propdef si necesitas declarar un parámetro externalizado (p. ej. para el \
Timer — ver más abajo). Si esos dos ficheros de parámetros ya existen y no se te han dado como "actuales", \
trátalos como vacíos y créalos con solo lo que necesites añadir. Si escribes parameters.propdef, la raíz \
del fichero debe ser EXACTAMENTE <parameters> (sin namespace, sin "paramDef" ni ningún otro nombre — usar \
otra raíz hace fallar la creación entera, verificado) y cada <parameter> necesita SIEMPRE los 7 elementos \
hijo <key/><name><type><isRequired><constraint/><description/><additionalMetadata/> (vacíos si no aplican) \
— falta alguno (sobre todo <description/>) y el tenant también lanza una excepción interna al crear/\
actualizar el iflow ENTERO, no solo ese parámetro (verificado). Ver el ejemplo completo del fichero en el \
componente de referencia del Timer si lo necesitas.
- "content" debe ser el contenido COMPLETO de cada fichero, nunca un diff ni un fragmento.
- No modifiques ni renombres el fichero .iflw dado — edítalo en el sitio (mismo "path").
- No inventes IDs de sistemas SAP Integration Suite ni credenciales; para adaptadores/canales usa \
valores de ejemplo razonables que el usuario pueda configurar después en las Configuraciones del iflow.
- Si los requisitos no pueden cumplirse por completo, haz lo posible y explica la limitación en "warnings".

Reglas para que el iflow sea DESPLEGABLE de verdad (el build/deploy de Cloud Integration valida esto y \
falla en despliegue, no en la creación, así que un iflow "sintácticamente válido" puede seguir sin poder \
desplegarse si no las sigues). Verificado repetidas veces contra un tenant real: cada adaptador (HTTP, \
OData, SuccessFactors, lo que sea) tiene un número de versión de componente interno (p. ej. \
"cmdVariantUri".../version::X) que depende de qué está instalado en ESE tenant concreto — no tienes forma \
de saber cuál es el correcto, e inventarte uno (aunque copies "1.0" del Sender/Receiver genérico de la \
plantilla, que es un componente distinto) hace fallar el build con errores como "This component X with \
version Y is not supported" o "component is not available in your design workspace", incluso con \
adaptadores en principio estándar como HTTP u OData.
- Si más abajo se te da una sección "## Componentes de referencia reales", esos fragmentos son EJEMPLOS \
REALES ya verificados (extraídos de iflows reales que sí despliegan) — cubren adaptadores en ambas \
direcciones (HTTP/SOAP/OData V2/OData V4/JDBC/SFTP/AS2/IDoc/JMS/Mail/ProcessDirect/SuccessFactors), pasos de \
enrutado/división/combinación (Router, Splitter, Gather, Join, Multicast), mapeo (Message Mapping), \
llamadas a subprocesos (Local Integration Process, Looping Process) y manejo de errores (Exception \
Subprocess). Cuando necesites ese tipo de componente, COPIA exactamente sus propiedades \
"cmdVariantUri"/"componentVersion"/"TransportProtocolVersion" tal cual aparecen (adaptando solo dirección/ \
address/credenciales/valores de negocio a tu caso), en vez de inventar una versión. Si alguno trae una nota \
"caveat", inclúyela adaptada en "warnings". Para el patrón "Local Integration Process": son DOS piezas que \
van siempre juntas — el elemento "process" del subproceso (sibling de tu proceso principal, con su propio \
id) y el elemento "callActivity" que lo invoca (con "processId" apuntando exactamente a ese id) — copia \
ambas piezas o ninguna, nunca solo una.
- CRÍTICO — visto causando "Error while loading the details of the integration flow" al abrir un iflow real \
en Integration Suite (el editor no puede ni cargarlo): cada vez que conectes un adaptador (el \
"messageFlow" de un componente de referencia) a un paso del proceso principal, ese paso (el \
"serviceTask"/"callActivity" que sea el "sourceRef"/"targetRef" del messageFlow) DEBE llevar TAMBIÉN, en su \
propio "extensionElements", el bloque del componente de referencia "ServiceTask ExternalCall" \
("activityType": "ExternalCall", ese "cmdVariantUri") — EXCEPTO el adaptador Mail (ver más abajo), que usa \
un bloque distinto. Configurar solo el messageFlow SIN esta pieza deja el paso "sin tipo" — parece \
sintácticamente válido pero rompe el editor gráfico real y el esquema visual de esta misma app. Añade \
SIEMPRE ambas piezas juntas (el messageFlow del adaptador Y este bloque en el paso que lo usa), nunca solo \
una.
- El adaptador Mail es la ÚNICA excepción a la regla anterior: es "fire-and-forget" (no espera respuesta \
del servidor SMTP), así que el paso que lo usa NO lleva el bloque "ServiceTask ExternalCall" — lleva en su \
lugar el bloque del componente de referencia "Send" ("activityType": "Send", cmdVariantUri \
"ctype::FlowstepVariant/cname::Send/version::1.0.4"). Usar ExternalCall con Mail modela el envío como una \
petición-respuesta que en realidad nunca ocurre — evítalo aunque no llegue a bloquear el build.
- Para cualquier adaptador/canal real que NECESITES pero para el que NO se te haya dado un componente de \
referencia arriba: NO lo inventes. Implementa un paso "Content Modifier" + un script Groovy nuevo (bajo \
src/main/resources/script/) que simule/registre esa llamada (p. ej. deja un comentario TODO y un log con lo \
que habría que llamar) en vez de un adaptador real — así el iflow siempre es desplegable, y explica SIEMPRE \
en "warnings" qué llamada queda pendiente de configurar manualmente con el adaptador real desde el editor \
gráfico de Integration Suite (ahí sí se elige automáticamente la versión correcta del adaptador instalado \
en el tenant). Esta misma regla aplica si el .iflw que se te ha dado YA tiene un adaptador de un tipo \
distinto al que necesitas — solo reutiliza un "cmdVariantUri" existente si es del MISMO tipo de adaptador \
que ya necesitas, nunca lo apliques a un tipo distinto.
- Si usas un Timer Start Event, dale SIEMPRE una planificación completa siguiendo el patrón del componente \
de referencia del Timer (parámetro externalizado "custom:schedule" en parameters.prop/parameters.propdef, \
NO una propiedad de texto libre dentro del propio .iflw) — un Timer sin esa planificación hace fallar el \
build con "Timer is not configured". Si no hace falta arrancar por temporizador, usa un Start Message Event \
normal en su lugar (más seguro, salvo que el .iflw ya tenga un Timer configurado y solo haga falta tocar \
otra cosa).
- Cada canal debe tener un "Name" ÚNICO dentro del flujo — nunca repitas el mismo nombre de canal en dos \
sitios distintos, aunque sean del mismo sistema.
- Si añades un paso "Splitter" (dividir un mensaje en varios para procesarlos uno a uno), usa SIEMPRE la \
variante "General Splitter" ("splitType": "GeneralSplitter", "exprType": "XPath", cmdVariantUri \
"ctype::FlowstepVariant/cname::GeneralSplitter/version::1.6.0") — NUNCA la variante "Iterating Splitter" \
("splitType": "Camel", cname "Camel"): esta última NO está soportada en este tenant en absoluto \
("Iterating Splitter not supported for IFLMAP runtime" / "This component Iterating Splitter with version \
1.6 is not supported in Cloud Integration profile"), falla el build siempre, sea cual sea su configuración. \
Rellena SIEMPRE "splitExprValue" con la ruta XPath real por la que dividir (p. ej. "//row" o "//Ausencia") \
basándote en la estructura REAL del mensaje que produce el paso anterior en TU propio diseño (mira qué XML \
genera el Content Modifier o script Groovy justo antes del Splitter). Un Splitter sin esa expresión falla \
en el editor gráfico con "Token/XPath not defined by splitter step". Si genuinamente no puedes determinar \
la estructura del mensaje de entrada en ese punto (p. ej. porque viene de un sistema externo cuyo formato \
no conoces), déjalo en blanco y explica en "warnings" que hay que configurarlo manualmente — no inventes \
una expresión sin base en el diseño real.
- Para un paso "Data Store" (Get/Put/Select/Delete, "activityType": "DBstorage"), el campo que SAP exige \
como obligatorio es SIEMPRE "storageName" ("Data Store Name" en el editor) — en el paso "Get" existe \
TAMBIÉN un campo "dataStoreId" que NO es el que se valida como obligatorio; rellena "storageName" en TODOS \
los pasos Data Store del mismo diseño con EXACTAMENTE el mismo valor (el nombre del data store), no solo \
"dataStoreId". Dejar "storageName" vacío falla el build con "'Data Store Name' cannot be empty" aunque \
"dataStoreId" esté relleno.
- CRÍTICO — visto causando "Error while loading the details of the integration flow" al abrir un iflow real \
en Integration Suite (el editor no puede ni cargarlo), en un caso donde el iflow SÍ compilaba/desplegaba: \
cada elemento del proceso (startEvent, endEvent, serviceTask, callActivity, subProcess...) que añadas o \
edites en la sección "bpmn2:process" (o dentro de un "bpmn2:subProcess") necesita TAMBIÉN su propio \
"bpmndi:BPMNShape" (con "dc:Bounds") en la sección "bpmndi:BPMNDiagram" al final del fichero, y cada \
"sequenceFlow"/"messageFlow" que conecte necesita su propio "bpmndi:BPMNEdge" (con dos "di:waypoint", \
"xsi:type=\"dc:Point\"") — visto fallando específicamente en un "Exception Subprocess": se añadió el \
"BPMNShape" del subProcess contenedor pero NUNCA los de sus elementos internos (el startEvent/callActivity/ \
serviceTask/endEvent DE DENTRO del subproceso), dejando el diagrama incompleto — el iflow compilaba bien \
pero el editor gráfico no podía cargarlo. Si añades un subProcess con pasos dentro, no olvides el \
BPMNShape de CADA UNO de esos pasos internos, no solo el del subProcess en sí. Coloca los nuevos \
BPMNShape dentro de los límites (dc:Bounds) del elemento contenedor si es un subProcess, y los BPMNEdge \
con waypoints que conecten el centro aproximado de un shape con el del siguiente.
- Si usas algún valor de ejemplo/placeholder que el usuario deba revisar antes de un uso real \
(credenciales, URLs, la llamada simulada al sistema externo, planificación del Timer, etc.), enuméralos en \
"warnings" para que sepa qué configurar.`

const SYSTEM_PROMPT_CREATE = `Eres un experto en SAP Cloud Integration (Integration Suite / iflows). Se te da \
el esqueleto de un iflow vacío recién creado (definición gráfica .iflw sin pasos, solo Sender/Receiver/Start/End) \
y unos requisitos funcionales (prompt del usuario o texto extraído de un diseño técnico).

Tu tarea: extender ese esqueleto añadiendo los pasos necesarios (content modifiers, mappings, llamadas a \
sistemas, routers, etc.) dentro del MISMO fichero .iflw para implementar los requisitos, añadiendo también \
cualquier script/mapping que haga falta como fichero nuevo.

${BASE_RULES}`

const SYSTEM_PROMPT_UPDATE = `Eres un experto en SAP Cloud Integration (Integration Suite / iflows). Se te da \
la definición gráfica (.iflw) y los scripts/mappings de un iflow YA EXISTENTE, junto con una petición de cambio \
(prompt del usuario o texto extraído de un diseño técnico).

Tu tarea: modificar ese iflow para satisfacer la petición, tocando solo lo necesario y preservando el resto \
del flujo intacto.

${BASE_RULES}`

function serializeComponents(components) {
  if (!components.length) return ''
  return '\n\n## Componentes de referencia reales (cópialos si necesitas ese tipo de componente)\n' +
    components.map(c => {
      const caveat = c.caveat ? `\n(Aviso a incluir en "warnings" si usas este componente: ${c.caveat})` : ''
      return `--- ${c.label} ---\n${c.xml}${caveat}`
    }).join('\n\n')
}

function buildUserContent({ mode, artifactName, description, sender, receiver, requirements, flowXml, scripts, parameters, componentIds }) {
  // "Adjuntando una plantilla" ya da el id exacto de cada componente (una columna con
  // desplegable validado, no texto libre) — seleccionar por id evita depender de que las
  // regex de palabras clave (pensadas para prompts en lenguaje natural) reconozcan bien un
  // id técnico con guiones. Prompt/diseño técnico siguen usando el matching por texto.
  const components = componentIds && componentIds.length
    ? selectComponentsByIds(componentIds)
    : selectRelevantComponents(requirements)

  return `## Iflow
Nombre: ${artifactName}
Descripción: ${description || '(sin descripción)'}
Sender: ${sender || '(sin especificar)'}
Receiver: ${receiver || '(sin especificar)'}

## Requisitos
${requirements || '(sin requisitos especificados)'}

## Definición gráfica actual (.iflw)
${serializeFiles('definición de flujo', flowXml)}

## Scripts y mappings actuales
${serializeFiles('scripts', scripts)}

## Parámetros externalizados actuales (parameters.prop / parameters.propdef)
Si necesitas añadir uno nuevo (p. ej. el del Timer), conserva TODO lo que ya haya aquí y añade solo tus \
líneas nuevas — nunca sobrescribas estos ficheros vacíos ni elimines entradas existentes sin relación con \
tu cambio.
${serializeFiles('parámetros', parameters || [])}${serializeComponents(components)}`
}

module.exports = {
  IFLOW_DESIGN_SCHEMA,
  SYSTEM_PROMPT_CREATE,
  SYSTEM_PROMPT_UPDATE,
  buildUserContent
}
