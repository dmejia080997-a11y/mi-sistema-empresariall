const { buildSystemPrompt } = require('./prompts/systemPrompt');
const { getTool, getToolDefinitions } = require('./toolRegistry');
const { hasToolPermission } = require('./permissions');

const rateBuckets = new Map();
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_MESSAGES_PER_MINUTE = Number(process.env.AI_MAX_MESSAGES_PER_MINUTE || 12);
const MAX_QUERIES_PER_USER = Number(process.env.AI_MAX_QUERIES_PER_USER || 300);

function isEnabled() {
  return String(process.env.AI_ENABLED || 'true').toLowerCase() === 'true';
}

function hasApiKey() {
  return Boolean(clean(process.env.OPENAI_API_KEY, 400));
}

function getModel() {
  return clean(process.env.AI_MODEL || DEFAULT_MODEL, 80) || DEFAULT_MODEL;
}

function getOpenAIClient() {
  let OpenAI;
  try {
    OpenAI = require('openai');
  } catch (err) {
    const error = new Error('La dependencia openai no esta instalada. Ejecuta npm install openai.');
    error.statusCode = 500;
    throw error;
  }
  if (!hasApiKey()) {
    const error = new Error('La IA no esta configurada: falta OPENAI_API_KEY en .env. Agrega tu llave y reinicia el servidor.');
    error.statusCode = 500;
    throw error;
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

async function ensureSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS ai_conversations (
    id BIGSERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    title TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS ai_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS ai_tool_logs (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    parameters TEXT,
    result TEXT,
    executed_by INTEGER,
    execution_ms INTEGER NOT NULL DEFAULT 0,
    company_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id)
  )`);
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_ai_conversations_company_user ON ai_conversations (company_id, user_id, updated_at)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages (conversation_id, created_at)');
  await run(db, 'CREATE INDEX IF NOT EXISTS idx_ai_tool_logs_conversation ON ai_tool_logs (conversation_id, created_at)');
}

async function listConversations(db, context) {
  return all(db, `
    SELECT id, title, created_at, updated_at
    FROM ai_conversations
    WHERE company_id = ? AND user_id = ?
    ORDER BY updated_at DESC, id DESC LIMIT 100`, [context.companyId, context.userId]);
}

async function getConversation(db, context, conversationId) {
  if (!conversationId) return null;
  return get(db, 'SELECT * FROM ai_conversations WHERE id = ? AND company_id = ? AND user_id = ?', [conversationId, context.companyId, context.userId]);
}

async function getMessages(db, context, conversationId) {
  const conversation = await getConversation(db, context, conversationId);
  if (!conversation) return [];
  return all(db, `
    SELECT id, role, content, created_at
    FROM ai_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC`, [conversation.id]);
}

async function createConversation(db, context, title) {
  const safeTitle = clean(title, 120) || 'Nueva conversacion';
  const inserted = await run(db, `
    INSERT INTO ai_conversations (company_id, user_id, title, created_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [context.companyId, context.userId, safeTitle]);
  return getConversation(db, context, inserted.lastID);
}

async function sendMessage(db, context, input) {
  if (!isEnabled()) {
    const error = new Error('AI_DISABLED');
    error.statusCode = 403;
    throw error;
  }
  const content = clean(input.content || input.question, 8000);
  if (!content) {
    const error = new Error('Mensaje requerido.');
    error.statusCode = 400;
    throw error;
  }
  if (!context.companyId) {
    const error = new Error('company_id no encontrado en la sesion.');
    error.statusCode = 400;
    throw error;
  }
  if (!context.userId) {
    const error = new Error('user_id no encontrado en req.user o session.user.');
    error.statusCode = 401;
    throw error;
  }
  if (input.clientCompanyId && Number(input.clientCompanyId) !== Number(context.companyId)) {
    console.warn('[aiService] company_id del cliente no coincide con la sesion', {
      clientCompanyId: input.clientCompanyId,
      sessionCompanyId: context.companyId
    });
  }
  if (input.clientUserId && Number(input.clientUserId) !== Number(context.userId)) {
    console.warn('[aiService] user_id del cliente no coincide con la sesion', {
      clientUserId: input.clientUserId,
      sessionUserId: context.userId
    });
  }
  hitLimits(context.userId);

  const conversation = input.conversationId
    ? await getConversation(db, context, Number(input.conversationId))
    : await createConversation(db, context, titleFrom(content));
  if (!conversation) {
    const error = new Error('Conversacion no encontrada.');
    error.statusCode = 404;
    throw error;
  }

  await insertMessage(db, conversation.id, 'user', content);
  await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);

  const history = await all(db, `
    SELECT role, content FROM ai_messages
    WHERE conversation_id = ?
    ORDER BY id DESC LIMIT 20`, [conversation.id]);
  const messages = [
    { role: 'system', content: buildSystemPrompt(context) },
    ...history.reverse().map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }))
  ];

  const tools = safeGetToolDefinitions(context);
  let answer = '';
  const toolResults = [];
  const localSelection = selectLocalTool(content);

  if (localSelection && localSelection.forceLocal) {
    const local = await runLocalAssistant(db, context, conversation.id, content, localSelection);
    answer = local.answer;
    toolResults.push(...local.toolResults);
    const assistant = await insertMessage(db, conversation.id, 'assistant', answer || 'Consulta ejecutada.');
    await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);
    return {
      conversation: { id: conversation.id, title: conversation.title },
      message: assistant,
      answer: assistant.content,
      tool_results: toolResults,
      provider: 'internal'
    };
  }

  if (!hasApiKey()) {
    const local = await runLocalAssistant(db, context, conversation.id, content, localSelection);
    answer = local.answer;
    toolResults.push(...local.toolResults);
    const assistant = await insertMessage(db, conversation.id, 'assistant', answer || 'Consulta recibida.');
    await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);
    return {
      conversation: { id: conversation.id, title: conversation.title },
      message: assistant,
      answer: assistant.content,
      tool_results: toolResults,
      provider: 'internal'
    };
  }

  try {
    const first = await openAiChat({ messages, tools });
    answer = first.content || '';
    const toolCalls = first.tool_calls || [];

    if (toolCalls.length) {
      const followupMessages = [...messages, { role: 'assistant', content: first.content || '', tool_calls: toolCalls }];
      for (const call of toolCalls.slice(0, 6)) {
        const toolName = call.function && call.function.name;
        const tool = getTool(toolName);
        const args = parseJson(call.function && call.function.arguments, {});
        const started = Date.now();
        let result;
        try {
          if (!tool || !hasToolPermission(context, tool)) {
            result = { error: 'No tienes permisos para consultar esa información.' };
          } else {
            result = await tool.execute(args, context);
          }
        } catch (err) {
          console.error('[AI ERROR]', err);
          result = normalizeToolError(err);
        }
        const executionMs = Date.now() - started;
        await logTool(db, conversation.id, context, toolName, args, result, executionMs);
        toolResults.push({ tool: toolName, parameters: args, result, execution_ms: executionMs });
        followupMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result || null).slice(0, 20000)
        });
      }
      const second = await openAiChat({ messages: followupMessages, tools });
      answer = second.content || answer || 'Consulta ejecutada.';
    }
  } catch (err) {
    console.error('[AI PROVIDER ERROR]', summarizeProviderError(err));
    const local = await runLocalAssistant(db, context, conversation.id, content);
    if (local && local.answer) {
      const assistant = await insertMessage(db, conversation.id, 'assistant', local.answer);
      await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);
      return {
        conversation: { id: conversation.id, title: conversation.title },
        message: assistant,
        answer: assistant.content,
        tool_results: local.toolResults,
        provider: 'internal'
      };
    }
    const detail = formatProviderError(err);
    const assistant = await insertMessage(db, conversation.id, 'assistant', `Error IA: ${detail}`);
    await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);
    return {
      ok: false,
      conversation: { id: conversation.id, title: conversation.title },
      message: assistant,
      error: detail
    };
  }

  const assistant = await insertMessage(db, conversation.id, 'assistant', answer || 'No pude generar una respuesta.');
  await run(db, 'UPDATE ai_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND company_id = ?', [conversation.id, context.companyId]);

  return {
    conversation: { id: conversation.id, title: conversation.title },
    message: assistant,
    answer: assistant.content,
    tool_results: toolResults
  };
}

async function runLocalAssistant(db, context, conversationId, content, knownSelection) {
  const selection = knownSelection || selectLocalTool(content) || await selectPendingTool(db, conversationId, content);
  if (!selection) {
    return {
      answer: await buildFallbackAnswer(db, conversationId, content),
      toolResults: []
    };
  }
  if (selection.answer) {
    return {
      answer: selection.answer,
      toolResults: []
    };
  }
  if (Array.isArray(selection.aggregate) && selection.aggregate.length) {
    return runAggregateSelection(db, context, conversationId, selection);
  }

  const candidateNames = [selection.name, ...(selection.alternatives || [])];
  const selectedName = candidateNames.find((name) => {
    const candidate = getTool(name);
    return candidate && hasToolPermission(context, candidate);
  });
  const tool = selectedName ? getTool(selectedName) : null;
  if (!tool) {
    return {
      answer: 'No tengo permiso para consultar esa informacion con tu usuario.',
      toolResults: []
    };
  }
  const missing = getMissingRequiredFields(tool, selection.args || {});
  if (missing.length) {
    return {
      answer: buildMissingFieldsAnswer(selection, missing),
      toolResults: []
    };
  }

  const started = Date.now();
  let result;
  try {
    result = await tool.execute(selection.args || {}, context);
  } catch (err) {
    console.error('[AI INTERNAL ERROR]', err);
    result = normalizeToolError(err);
  }
  const executionMs = Date.now() - started;
  await logTool(db, conversationId, context, selectedName, selection.args || {}, result, executionMs);
  return {
    answer: formatLocalAnswer(selection, result),
    toolResults: [{ tool: selectedName, parameters: selection.args || {}, result, execution_ms: executionMs }]
  };
}

async function buildFallbackAnswer(db, conversationId, content) {
  const recentRows = await all(db, `
    SELECT role, content
    FROM ai_messages
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT 8`, [conversationId]).catch(() => []);
  const recentText = normalize(recentRows.map((row) => row.content).join(' '));
  const text = normalize(content);

  const conversational = buildConversationalAnswer(content, text, recentText);
  if (conversational) return conversational;

  const suggestion = inferSuggestion(text, recentText);
  if (suggestion) return suggestion;

  return [
    'Te entiendo, pero necesito un dato mas para responder bien.',
    'Indica la accion y el dato principal. Por ejemplo: "busca cliente Juan Perez", "facturas pendientes de pago" o "stock del producto X".'
  ].join('\n');
}

function buildConversationalAnswer(content, text, recentText) {
  const original = clean(content, 1200);
  const shortText = text.split(/\s+/).filter(Boolean);

  if (hasAny(text, ['hola', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey'])) {
    return 'Hola. Dime que necesitas revisar o hacer en el sistema y te ayudo paso a paso.';
  }
  if (hasAny(text, ['gracias', 'muchas gracias', 'te agradezco'])) {
    return 'Con gusto. Si necesitas revisar otro dato o preparar otra accion, dime cual es.';
  }
  if (hasAny(text, ['quien eres', 'que eres', 'como funcionas'])) {
    return 'Soy el asistente del sistema. Puedo ayudarte a consultar datos de la empresa abierta, preparar textos, buscar registros y ejecutar acciones permitidas segun tus permisos.';
  }
  if (hasAny(text, ['que puedes hacer', 'en que me ayudas', 'ayuda', 'necesito ayuda'])) {
    return [
      'Puedo ayudarte con consultas y tareas del sistema.',
      'Por ejemplo: buscar clientes, revisar facturas pendientes, consultar ventas, ver inventario, localizar paquetes, revisar proveedores, proyectos o empleados, y redactar mensajes empresariales.'
    ].join('\n');
  }
  if (hasAny(text, ['como hago', 'como puedo', 'donde encuentro', 'como se hace'])) {
    return [
      'Puedo guiarte, pero necesito saber el modulo o la accion exacta.',
      `Quieres que te explique como hacer esto: "${original}"? Si aplica a clientes, facturas, inventario, paquetes, ventas o proyectos, dime cual de esos modulos estas usando.`
    ].join('\n');
  }
  if (hasAny(text, ['si', 'ok', 'dale', 'correcto', 'esta bien']) && recentText.includes('necesito')) {
    return 'Perfecto. Enviame el dato que falta y continuo con la accion pendiente.';
  }
  if (shortText.length <= 3 && recentText.includes('buscar')) {
    return `Quieres que lo busque como "${original}"? Indica el tipo de registro: cliente, factura, producto, paquete, proveedor o empleado.`;
  }
  return '';
}

function inferSuggestion(text, recentText) {
  if (hasAny(text, ['debe', 'deben', 'cobrar', 'cobro', 'pendiente', 'pago'])) {
    return 'Quieres ver cuentas por cobrar? Pidelo como: "facturas pendientes de pago" o "clientes con saldo pendiente".';
  }
  if (hasAny(text, ['vendi', 'vendido', 'venta', 'facture', 'facturado', 'ingreso'])) {
    return 'Quieres consultar ventas? Pidelo como: "ventas de este mes", "ventas de hoy" o "ventas por vendedor".';
  }
  if (hasAny(text, ['existencia', 'existencias', 'stock', 'hay de', 'producto'])) {
    return 'Quieres consultar inventario? Pidelo como: "stock de [producto]" o "inventario bajo minimo".';
  }
  if (hasAny(text, ['cotiza', 'cotizacion', 'presupuesto'])) {
    return 'Para crear la cotizacion necesito cliente, producto o servicio, cantidad y precio. Ejemplo: "crea cotizacion cliente Juan, servicio mantenimiento, cantidad 1, precio 100 USD".';
  }
  if (hasAny(text, ['crear', 'agregar', 'registrar', 'nuevo']) && (recentText.includes('cliente') || text.includes('cliente'))) {
    return 'Para crear el cliente necesito al menos el nombre. Ejemplo: "crea cliente Juan Perez telefono 5555-5555 correo juan@empresa.com".';
  }
  if (recentText.includes('cliente') && text.split(/\s+/).filter(Boolean).length <= 4) {
    return `Quieres buscar un cliente? Pidelo como: "buscar cliente ${clean(text, 80)}".`;
  }
  if (recentText.includes('paquete') && text.split(/\s+/).filter(Boolean).length <= 4) {
    return `Quieres buscar un paquete? Pidelo como: "buscar paquete ${clean(text, 80)}".`;
  }
  return '';
}

async function runAggregateSelection(db, context, conversationId, selection) {
  const sections = [];
  const toolResults = [];
  for (const item of selection.aggregate.slice(0, 8)) {
    const candidateNames = [item.name, ...(item.alternatives || [])];
    const selectedName = candidateNames.find((name) => {
      const candidate = getTool(name);
      return candidate && hasToolPermission(context, candidate);
    });
    const tool = selectedName ? getTool(selectedName) : null;
    if (!tool) continue;
    const missing = getMissingRequiredFields(tool, item.args || {});
    if (missing.length) continue;
    const started = Date.now();
    let result;
    try {
      result = await tool.execute(item.args || {}, context);
    } catch (err) {
      console.error('[AI INTERNAL ERROR]', err);
      result = normalizeToolError(err);
    }
    const executionMs = Date.now() - started;
    await logTool(db, conversationId, context, selectedName, item.args || {}, result, executionMs);
    toolResults.push({ tool: selectedName, parameters: item.args || {}, result, execution_ms: executionMs });
    sections.push(formatLocalAnswer({ name: selectedName, label: item.label || selectedName }, result));
  }
  if (!sections.length) {
    return {
      answer: 'No tengo permisos suficientes para resumir informacion del sistema con tu usuario.',
      toolResults
    };
  }
  return {
    answer: `Resumen general del sistema:\n\n${sections.join('\n\n')}`,
    toolResults
  };
}

function selectLocalTool(content) {
  const text = normalize(content);
  const q = extractSearchTerm(content);
  const limit = extractLimit(content);
  const id = extractId(content);
  if (hasAny(text, ['eliminar', 'borrar', 'anular', 'void', 'cancelar factura', 'cancelar cliente'])) {
    return {
      label: 'Accion no disponible',
      args: {},
      answer: 'No puedo eliminar, anular ni cancelar registros desde Asistente. Si quieres, puedo buscar el registro, resumirlo o ayudarte con una accion permitida para la empresa abierta.',
      forceLocal: true
    };
  }
  if (hasAny(text, [
    'toda la informacion',
    'informacion del sistema',
    'resumen del sistema',
    'resumen general',
    'panorama general',
    'que hay en el sistema',
    'que informacion tienes'
  ])) {
    const aggregateLimit = limit || 10;
    return {
      label: 'Resumen general',
      args: {},
      aggregate: [
        { name: 'listarClientes', label: 'Clientes', args: { limite: aggregateLimit } },
        { name: 'ventasMesActual', alternatives: ['ventasMes'], label: 'Ventas del mes', args: {} },
        { name: 'facturasPendientes', label: 'Facturas pendientes', args: { limite: aggregateLimit } },
        { name: 'stockDisponible', label: 'Inventario', args: {} },
        { name: 'paquetesPendientes', label: 'Paquetes pendientes', args: { limite: aggregateLimit } },
        { name: 'listarProveedores', label: 'Proveedores', args: { limite: aggregateLimit } },
        { name: 'proyectosActivos', label: 'Proyectos activos', args: { limite: aggregateLimit } },
        { name: 'ventasPorVendedor', label: 'Ventas por vendedor', args: {} }
      ],
      forceLocal: true
    };
  }
  if (
    hasAny(text, ['crear cliente', 'nuevo cliente', 'agregar cliente', 'registrar cliente']) ||
    (hasAny(text, ['crea', 'crear', 'agrega', 'agregar', 'registra', 'registrar', 'alta']) && hasAny(text, ['cliente']))
  ) {
    const name = extractEntityName(content, ['crear cliente', 'nuevo cliente', 'agregar cliente', 'registrar cliente', 'cliente']);
    return {
      name: 'crearCliente',
      label: 'Cliente creado',
      args: {
        name: name || q,
        phone: extractPhone(content),
        email: extractEmail(content),
        document_number: extractDocumentNumber(content),
        address: extractField(content, ['direccion', 'direccion:', 'address']),
        notes: extractField(content, ['nota', 'notas', 'observacion', 'observaciones'])
      },
      forceLocal: true
    };
  }
  if (
    hasAny(text, ['editar cliente', 'actualizar cliente', 'modificar cliente']) ||
    (id && hasAny(text, ['cliente']) && hasAny(text, ['editar', 'actualizar', 'modificar', 'cambiar']))
  ) {
    return {
      name: 'editarCliente',
      label: 'Cliente actualizado',
      args: {
        id,
        name: extractEntityName(content, ['editar cliente', 'actualizar cliente', 'modificar cliente']),
        phone: extractPhone(content),
        email: extractEmail(content),
        address: extractField(content, ['direccion', 'address']),
        notes: extractField(content, ['nota', 'notas', 'observacion', 'observaciones'])
      },
      forceLocal: true
    };
  }
  if (hasAny(text, ['buscar factura', 'busca factura', 'factura numero', 'factura #', 'factura no'])) {
    return { name: 'buscarFactura', label: 'Facturas encontradas', args: { q: q || extractInvoiceTerm(content) || content }, forceLocal: true };
  }
  if (hasAny(text, ['factura pendiente', 'facturas pendiente', 'por cobrar', 'saldo pendiente', 'pendiente de pago'])) {
    return { name: 'facturasPendientes', label: 'Facturas pendientes', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['factura vencida', 'facturas vencida', 'vencidas', 'vencidos'])) {
    return { name: 'facturasVencidas', label: 'Facturas vencidas', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (
    hasAny(text, ['ventas del mes', 'venta del mes', 'facturacion del mes', 'este mes']) ||
    (hasAny(text, ['cuanto', 'cuanto llevo', 'cuanto vendi', 'vendi', 'vendido', 'facture', 'facturado']) && hasAny(text, ['venta', 'vendi', 'vendido', 'facture', 'facturado']))
  ) {
    return { name: 'ventasMesActual', alternatives: ['ventasMes'], label: 'Ventas del mes', args: {}, forceLocal: true };
  }
  if (hasAny(text, ['ventas del ano', 'ventas anuales', 'facturacion anual', 'por mes'])) {
    return { name: 'ventasAnuales', alternatives: ['ventasAnio'], label: 'Ventas anuales', args: {}, forceLocal: true };
  }
  if (
    hasAny(text, ['cotizaciones enviadas', 'cotizacion enviada', 'cotizaciones mandadas', 'cotizacion mandada']) ||
    (hasAny(text, ['cotizacion', 'cotizaciones']) && hasAny(text, ['enviada', 'enviadas', 'enviado', 'enviados', 'mandada', 'mandadas', 'sent']))
  ) {
    return { name: 'cotizacionesEnviadas', label: 'Cotizaciones enviadas', args: {}, forceLocal: true };
  }
  if (
    hasAny(text, ['crear cotizacion', 'nueva cotizacion', 'hacer cotizacion', 'haz una cotizacion', 'cotizale', 'cotizarle', 'cotizar a']) ||
    (hasAny(text, ['crea', 'crear', 'hacer', 'haz', 'genera', 'generar']) && hasAny(text, ['cotizacion', 'cotizar']))
  ) {
    const quoteLine = extractQuoteLine(content);
    return {
      name: 'crearCotizacion',
      label: 'Cotizacion creada',
      args: {
        cliente: extractField(content, ['cliente']) || extractQuoteCustomer(content),
        descripcion: extractField(content, ['descripcion', 'servicio', 'producto', 'concepto']) || quoteLine.descripcion,
        cantidad: quoteLine.cantidad || 1,
        precio_unitario: quoteLine.precio_unitario || extractMoney(content),
        moneda: extractCurrency(content),
        validez_dias: limit || 15,
        notas: extractField(content, ['nota', 'notas', 'observacion', 'observaciones'])
      },
      forceLocal: true
    };
  }
  if (hasAny(text, ['preparar cotizacion', 'borrador de cotizacion'])) {
    return {
      name: 'prepararCotizacion',
      label: 'Borrador de cotizacion',
      args: {
        cliente: extractField(content, ['cliente']) || q,
        descripcion: extractField(content, ['descripcion', 'servicio', 'producto']) || extractQuoteLine(content).descripcion,
        monto_estimado: extractMoney(content),
        moneda: extractCurrency(content),
        validez_dias: limit || 15
      },
      forceLocal: true
    };
  }
  if (hasAny(text, ['bajo minimo', 'stock bajo', 'inventario bajo', 'minimo'])) {
    return { name: 'productosBajoMinimo', label: 'Productos bajo minimo', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['stock', 'inventario disponible', 'existencia', 'existencias'])) {
    return { name: 'stockDisponible', label: 'Stock disponible', args: q ? { q } : {}, forceLocal: true };
  }
  if (hasAny(text, ['producto', 'sku', 'codigo'])) {
    return { name: 'buscarProducto', label: 'Productos encontrados', args: { q: q || content }, forceLocal: true };
  }
  if (hasAny(text, ['top clientes', 'mejores clientes', 'clientes principales', 'mayor venta'])) {
    return { name: 'topClientes', label: 'Clientes principales', args: { limite: limit || 10 }, forceLocal: true };
  }
  if (hasAny(text, ['ventas por vendedor', 'vendedor'])) {
    return { name: 'ventasPorVendedor', label: 'Ventas por vendedor', args: {}, forceLocal: true };
  }
  if (hasAny(text, ['proyectos atrasados', 'proyecto atrasado', 'atrasados'])) {
    return { name: 'proyectosAtrasados', label: 'Proyectos atrasados', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['proyectos activos', 'proyecto activo'])) {
    return { name: 'proyectosActivos', label: 'Proyectos activos', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['crear tarea', 'nueva tarea', 'agregar tarea']) && hasAny(text, ['proyecto'])) {
    return {
      name: 'crearTarea',
      label: 'Tarea creada',
      args: {
        project_id: id,
        title: extractField(content, ['tarea', 'titulo']) || extractEntityName(content, ['crear tarea', 'nueva tarea', 'agregar tarea']) || content,
        description: extractField(content, ['descripcion', 'detalle']),
        due_date: extractDate(content),
        priority: extractPriority(content)
      },
      forceLocal: true
    };
  }
  if (hasAny(text, ['proveedor', 'proveedores'])) {
    return { name: q ? 'buscarProveedor' : 'listarProveedores', label: 'Proveedores', args: q ? { q } : { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['tracking', 'paquete', 'paquetes', 'guia'])) {
    if (hasAny(text, ['pendiente', 'transito', 'en transito'])) {
      return { name: 'paquetesPendientes', label: 'Paquetes pendientes', args: { limite: limit || 20 }, forceLocal: true };
    }
    if (hasAny(text, ['urgente', 'antiguo', 'seguimiento'])) {
      return { name: 'paquetesUrgentes', label: 'Paquetes urgentes', args: { dias: limit || 7 }, forceLocal: true };
    }
    return { name: 'buscarTracking', label: 'Paquetes encontrados', args: { q: q || extractTrackingTerm(content) || content }, forceLocal: true };
  }
  if (hasAny(text, ['vacaciones pendientes', 'dias de vacaciones'])) {
    return { name: 'vacacionesPendientes', label: 'Vacaciones pendientes', args: { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['asistencia']) && id) {
    return { name: 'asistenciaEmpleado', label: 'Asistencia de empleado', args: { empleado_id: id, limite: limit || 10 }, forceLocal: true };
  }
  if (hasAny(text, ['empleado', 'empleados', 'rrhh', 'recursos humanos'])) {
    return { name: 'buscarEmpleado', label: 'Empleados encontrados', args: { q: q || content }, forceLocal: true };
  }
  if (hasAny(text, ['cliente', 'clientes'])) {
    return { name: q ? 'buscarCliente' : 'listarClientes', label: 'Clientes', args: q ? { query: q } : { limite: limit || 20 }, forceLocal: true };
  }
  if (hasAny(text, ['redacta', 'redactar', 'escribe', 'correo', 'carta', 'documento', 'mensaje'])) {
    return {
      name: 'generarDocumento',
      label: 'Documento preparado',
      args: { tipo: 'texto', asunto: titleFrom(content), contenido_base: content },
      forceLocal: false
    };
  }
  return null;
}

function formatLocalAnswer(selection, result) {
  if (selection && selection.name === 'generarDocumento') {
    return buildDocumentDraft(result);
  }
  if (selection && selection.name === 'crearCotizacion' && result && result.quote_number) {
    return [
      `Cotizacion creada: ${result.quote_number}`,
      `Cliente: ${result.cliente}`,
      `Total: ${result.total}`,
      `Estado: ${result.status}`,
      result.link ? `Ver/imprimir: ${result.link}` : ''
    ].filter(Boolean).join('\n');
  }
  if (result && result.message && !Array.isArray(result)) return result.message;
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.productos) ? result.productos : null);
  if (rows) {
    if (!rows.length) return `${selection.label}: no encontre registros.`;
    const lines = rows.slice(0, 10).map((row, index) => `${index + 1}. ${formatRow(row)}`);
    const extra = rows.length > 10 ? `\nMostrando 10 de ${rows.length} registros.` : '';
    return `${selection.label}:\n${lines.join('\n')}${extra}`;
  }
  if (result && typeof result === 'object') {
    const summary = result.resumen ? `Resumen: ${formatRow(result.resumen)}` : formatRow(result);
    return `${selection.label}: ${summary}`;
  }
  return `${selection.label}: ${String(result || 'sin datos')}`;
}

function buildDocumentDraft(result) {
  const base = clean(result && result.contenido_base, 2000);
  const asunto = clean(result && result.asunto, 180) || 'Mensaje empresarial';
  const text = normalize(base);

  if (hasAny(text, ['correo', 'email'])) {
    const purpose = base
      .replace(/\b(redacta|redactar|escribe|correo|email|mensaje|por favor)\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    return [
      `Asunto: ${asunto}`,
      '',
      'Buen dia,',
      '',
      purpose
        ? `Le escribo para dar seguimiento a lo siguiente: ${purpose}.`
        : 'Le escribo para dar seguimiento al tema pendiente.',
      '',
      'Quedo atento a sus comentarios para avanzar con lo necesario.',
      '',
      'Saludos cordiales.'
    ].join('\n');
  }

  if (hasAny(text, ['whatsapp', 'mensaje'])) {
    const purpose = base
      .replace(/\b(redacta|redactar|escribe|whatsapp|mensaje|por favor)\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();
    return purpose
      ? `Hola, buen dia. Le escribo para dar seguimiento a ${purpose}. Quedo atento a sus comentarios.`
      : 'Hola, buen dia. Le escribo para dar seguimiento al tema pendiente. Quedo atento a sus comentarios.';
  }

  return [
    asunto,
    '',
    base
      ? `Con relacion a lo solicitado, dejo el siguiente texto preparado:\n\n${base}`
      : 'Texto preparado. Indica el destinatario, tono y objetivo si quieres que lo deje mas preciso.'
  ].join('\n');
}

async function selectPendingTool(db, conversationId, content) {
  const previous = await get(db, `
    SELECT content
    FROM ai_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC
    LIMIT 1`, [conversationId]);
  const text = normalize(previous && previous.content);
  if (!text.includes('para ejecutar') || !text.includes('necesito')) return null;
  if (text.includes('cotizacion creada')) {
    const quoteLine = extractQuoteLine(content);
    return {
      name: 'crearCotizacion',
      label: 'Cotizacion creada',
      args: {
        cliente: extractField(content, ['cliente']) || extractQuoteCustomer(content),
        descripcion: extractField(content, ['descripcion', 'servicio', 'producto', 'concepto']) || quoteLine.descripcion,
        cantidad: quoteLine.cantidad || 1,
        precio_unitario: quoteLine.precio_unitario || extractMoney(content),
        moneda: extractCurrency(content),
        validez_dias: extractLimit(content) || 15,
        notas: extractField(content, ['nota', 'notas', 'observacion', 'observaciones'])
      },
      forceLocal: true
    };
  }
  if (text.includes('cliente creado')) {
    return {
      name: 'crearCliente',
      label: 'Cliente creado',
      args: {
        name: extractEntityName(content, ['nombre', 'cliente']) || extractField(content, ['nombre', 'cliente']),
        phone: extractPhone(content),
        email: extractEmail(content),
        document_number: extractDocumentNumber(content),
        address: extractField(content, ['direccion', 'address']),
        notes: extractField(content, ['nota', 'notas', 'observacion', 'observaciones'])
      },
      forceLocal: true
    };
  }
  return null;
}

function buildMissingFieldsAnswer(selection, missing) {
  const labels = missing.map((field) => FIELD_LABELS[field] || field);
  const examples = {
    crearCliente: 'Ejemplo: nombre Juan Perez, telefono 5555-5555, correo juan@empresa.com, NIT 123456-7.',
    crearCotizacion: 'Ejemplo: cliente Juan Perez, servicio mantenimiento mensual, cantidad 1, precio 100 USD.'
  };
  const example = examples[selection.name] ? `\n${examples[selection.name]}` : '';
  return `Para ejecutar "${selection.label}" necesito: ${labels.join(', ')}.${example}`;
}

const FIELD_LABELS = {
  name: 'nombre',
  cliente: 'cliente',
  descripcion: 'descripcion del producto o servicio',
  precio_unitario: 'precio unitario',
  id: 'id'
};

function formatRow(row) {
  return Object.entries(row || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${humanizeKey(key)}: ${formatValue(value)}`)
    .join(' | ');
}

function humanizeKey(key) {
  return String(key || '').replace(/_/g, ' ');
}

function formatValue(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function extractSearchTerm(content) {
  const match = String(content || '').match(/(?:buscar|busca|buscame|producto|cliente|stock|sku|codigo|proveedor|tracking|paquete|empleado|factura)\s+(.+)/i);
  return match ? clean(match[1], 120) : '';
}

function extractLimit(content) {
  const match = String(content || '').match(/\b(?:top|primeros|ultimos|limite|mostrar|muestra)?\s*(\d{1,2})\b/i);
  const value = match ? Number(match[1]) : 0;
  return value > 0 ? Math.min(value, 50) : 0;
}

function extractId(content) {
  const match = String(content || '').match(/\b(?:id|#|proyecto|cliente|empleado)\s*[:#-]?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function extractEmail(content) {
  const match = String(content || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function extractPhone(content) {
  const match = String(content || '').match(/(?:tel(?:efono)?|cel(?:ular)?|whatsapp|movil|telefono:)\s*[:#-]?\s*([+\d][\d\s().-]{6,})/i);
  return match ? clean(match[1], 40) : '';
}

function extractDocumentNumber(content) {
  const match = String(content || '').match(/(?:nit|dpi|documento)\s*[:#-]?\s*([A-Z0-9-]{4,})/i);
  return match ? clean(match[1], 60) : '';
}

function extractField(content, labels) {
  const source = String(content || '');
  for (const label of labels) {
    const re = new RegExp(`${escapeRegExp(label)}\\s*[:#-]?\\s*([^,;\\n]+)`, 'i');
    const match = source.match(re);
    if (match && match[1]) return clean(match[1], 300);
  }
  return '';
}

function extractEntityName(content, labels) {
  let value = String(content || '').trim();
  for (const label of labels) {
    const re = new RegExp(`^.*?${escapeRegExp(label)}\\s*[:#-]?\\s*`, 'i');
    value = value.replace(re, '');
  }
  value = value
    .replace(/\b(?:con|tel(?:efono)?|cel(?:ular)?|correo|email|nit|dpi|direccion|nota|notas)\b.*$/i, '')
    .replace(/[.;,]+$/g, '')
    .trim();
  return clean(value, 180);
}

function extractInvoiceTerm(content) {
  const match = String(content || '').match(/(?:factura|numero|no\.?|#)\s*[:#-]?\s*([A-Z0-9-]+)/i);
  return match ? clean(match[1], 80) : '';
}

function extractTrackingTerm(content) {
  const match = String(content || '').match(/(?:tracking|guia|paquete)\s*[:#-]?\s*([A-Z0-9-]+)/i);
  return match ? clean(match[1], 120) : '';
}

function extractMoney(content) {
  const match = String(content || '').match(/(?:precio|vale|valor|monto|por|a|de|Q|USD|\$)\s*[:#-]?\s*(?:Q|USD|\$)?\s*(\d+(?:[.,]\d{1,2})?)/i)
    || String(content || '').match(/(?:Q|USD|\$)\s*(\d+(?:[.,]\d{1,2})?)/i);
  return match ? Number(match[1].replace(',', '.')) : 0;
}

function extractQuoteCustomer(content) {
  const source = String(content || '');
  const match = source.match(/(?:cliente|para|a)\s+([^,;]+?)(?:\s+(?:servicio|producto|concepto|por|precio|de|con)\b|[,;]|$)/i);
  if (!match) return '';
  return clean(match[1].replace(/\b(cotizacion|cotizar|cotizale)\b/ig, ''), 180);
}

function extractQuoteLine(content) {
  const source = String(content || '');
  const cantidadMatch = source.match(/(?:cantidad|qty|x)\s*[:#-]?\s*(\d+(?:[.,]\d+)?)/i)
    || source.match(/\b(\d+(?:[.,]\d+)?)\s+(?:unidades|uds|servicios|productos|piezas)\b/i);
  const precioMatch = source.match(/(?:precio(?:\s+unitario)?|vale|valor|monto|por|a|de)\s*[:#-]?\s*(?:Q|USD|\$)?\s*(\d+(?:[.,]\d{1,2})?)/i)
    || source.match(/(?:Q|USD|\$)\s*(\d+(?:[.,]\d{1,2})?)/i);
  const descMatch = source.match(/(?:servicio|producto|descripcion|concepto)\s*[:#-]?\s*([^,;]+?)(?:\s+(?:cantidad|qty|precio|vale|valor|monto|por|a|de)\b|[,;]|$)/i);
  return {
    cantidad: cantidadMatch ? Number(cantidadMatch[1].replace(',', '.')) : 0,
    precio_unitario: precioMatch ? Number(precioMatch[1].replace(',', '.')) : 0,
    descripcion: descMatch ? clean(descMatch[1], 300) : ''
  };
}

function extractCurrency(content) {
  const text = normalize(content);
  if (text.includes('quetzal') || /\bq\s*\d/i.test(String(content || ''))) return 'GTQ';
  if (text.includes('dolar') || text.includes('usd') || String(content || '').includes('$')) return 'USD';
  return 'USD';
}

function extractDate(content) {
  const match = String(content || '').match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/);
  return match ? clean(match[1], 20) : '';
}

function extractPriority(content) {
  const text = normalize(content);
  if (text.includes('critica') || text.includes('critico')) return 'critical';
  if (text.includes('alta') || text.includes('urgente')) return 'high';
  if (text.includes('baja')) return 'low';
  return 'medium';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function hasAny(text, terms) {
  return terms.some((term) => text.includes(normalize(term)));
}

function getMissingRequiredFields(tool, args) {
  const required = tool && tool.parameters && Array.isArray(tool.parameters.required)
    ? tool.parameters.required
    : [];
  return required.filter((field) => {
    const value = args ? args[field] : undefined;
    return value === null || value === undefined || value === '';
  });
}

async function insertMessage(db, conversationId, role, content) {
  const inserted = await run(db, 'INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [conversationId, role, content]);
  return get(db, 'SELECT id, role, content, created_at FROM ai_messages WHERE id = ?', [inserted.lastID]);
}

async function logTool(db, conversationId, context, toolName, params, result, executionMs) {
  await run(db, `
    INSERT INTO ai_tool_logs (conversation_id, tool_name, parameters, result, executed_by, execution_ms, company_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [conversationId, toolName || '', JSON.stringify(params || {}), JSON.stringify(result || null).slice(0, 20000), context.userId, executionMs, context.companyId]);
}

function hitLimits(userId) {
  const now = Date.now();
  const key = String(userId || 'anonymous');
  const bucket = rateBuckets.get(key) || { minuteStart: now, minuteCount: 0, total: 0 };
  if (now - bucket.minuteStart > 60000) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }
  bucket.minuteCount += 1;
  bucket.total += 1;
  rateBuckets.set(key, bucket);
  if (bucket.minuteCount > MAX_MESSAGES_PER_MINUTE) {
    const error = new Error('Limite de mensajes por minuto excedido.');
    error.statusCode = 429;
    throw error;
  }
  if (bucket.total > MAX_QUERIES_PER_USER) {
    const error = new Error('Limite de consultas por usuario excedido.');
    error.statusCode = 429;
    throw error;
  }
}

function safeGetToolDefinitions(context) {
  try {
    const tools = getToolDefinitions(context);
    console.log('[AI] tools cargadas:', tools.length);
    return tools;
  } catch (err) {
    console.error('[AI ERROR]', err);
    return [];
  }
}

async function openAiChat(payload) {
  const client = getOpenAIClient();
  const completion = await client.chat.completions.create({
    model: getModel(),
    messages: payload.messages,
    tools: payload.tools && payload.tools.length ? payload.tools : undefined,
    tool_choice: payload.tools && payload.tools.length ? 'auto' : undefined,
    temperature: 0.45,
    max_tokens: 1200
  });
  return (completion.choices && completion.choices[0] && completion.choices[0].message) || { content: '' };
}

async function testOpenAI() {
  if (!isEnabled()) {
    const error = new Error('AI_DISABLED');
    error.statusCode = 403;
    throw error;
  }
  try {
    await openAiChat({
      messages: [
        { role: 'system', content: 'Responde exactamente: IA funcionando correctamente' },
        { role: 'user', content: 'Prueba de conexion.' }
      ],
      tools: []
    });
  } catch (err) {
    const error = new Error(formatProviderError(err));
    error.statusCode = providerErrorStatus(err);
    error.code = err && (err.code || err.type);
    error.providerError = summarizeProviderError(err);
    throw error;
  }
  return 'IA funcionando correctamente';
}

function providerErrorStatus(err) {
  if (isProviderQuotaError(err)) return 402;
  const status = Number(err && (err.status || err.statusCode));
  return status >= 400 ? status : 502;
}

function isProviderQuotaError(err) {
  const code = String(err && (err.code || err.type || '')).toLowerCase();
  const message = String(err && err.message ? err.message : '').toLowerCase();
  return code === 'insufficient_quota' || message.includes('exceeded your current quota');
}

function formatProviderError(err) {
  if (isProviderQuotaError(err)) {
    return 'La cuenta de OpenAI no tiene cuota disponible. Revisa el plan, saldo o metodo de pago de la API key configurada en OPENAI_API_KEY.';
  }
  const status = Number(err && (err.status || err.statusCode));
  if (status === 401) return 'La API key de OpenAI no es valida o fue rechazada.';
  if (status === 429) return 'OpenAI limito temporalmente las solicitudes. Intenta de nuevo en unos minutos.';
  return (err && err.message) || String(err || 'Error al conectar con OpenAI.');
}

function summarizeProviderError(err) {
  return {
    status: err && (err.status || err.statusCode),
    code: err && err.code,
    type: err && err.type,
    message: formatProviderError(err)
  };
}

function normalizeToolError(err) {
  const message = String(err && err.message ? err.message : err);
  if (/no such table|no such column|SQLITE_ERROR/i.test(message)) {
    return { message: 'El modulo todavia no tiene datos disponibles o la tabla no existe.' };
  }
  return { error: message || 'Error al ejecutar herramienta.' };
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(err) {
    return err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch (err) {
    return fallback;
  }
}

function titleFrom(content) {
  return clean(content, 60) || 'Nueva conversacion';
}

module.exports = {
  createConversation,
  ensureSchema,
  getConversation,
  getMessages,
  getModel,
  hasApiKey,
  isEnabled,
  listConversations,
  sendMessage,
  testOpenAI
};
