# Asistente

Modulo central de asistente tipo ChatGPT para el sistema multiempresa.

## Variables de entorno

Configurar en `.env`:

```env
OPENAI_API_KEY=
AI_MODEL=gpt-4.1-mini
AI_ENABLED=true
```

Opcionales:

```env
AI_MAX_MESSAGES_PER_MINUTE=12
AI_MAX_QUERIES_PER_USER=300
```

## Rutas

- `GET /ai`: vista principal del chat.
- `GET /ai/conversations`: historial del usuario autenticado y empresa actual.
- `POST /ai/conversations`: nueva conversacion.
- `GET /ai/conversations/:id/messages`: mensajes de una conversacion.
- `POST /ai/messages`: envia mensaje al asistente.
- `POST /ai/chat`: alias JSON compatible con el widget flotante existente.

## Seguridad

- Todas las conversaciones se filtran por `company_id` y `user_id`.
- Todas las herramientas reciben `companyId` desde la sesion, no desde el modelo.
- Cada herramienta declara permiso `[modulo, accion]`.
- Si el usuario no tiene permiso, la herramienta no se expone al modelo.
- No hay herramientas de eliminacion habilitadas. Si se pide eliminar informacion, la IA debe indicar que esa accion no esta disponible y seguir ofreciendo acciones permitidas.
- `AI_ENABLED=false` bloquea el uso del chat.

## Herramientas

Los archivos se cargan automaticamente desde:

```text
src/ai/tools/*.tools.js
```

Para agregar un modulo nuevo, crear:

```text
src/ai/tools/nuevoModulo.tools.js
```

Cada herramienta debe exportar objetos con:

```js
{
  name: 'nombreHerramienta',
  description: 'Descripcion',
  permission: ['modulo', 'accion'],
  parameters: { type: 'object', properties: {} },
  execute: async (args, context) => {}
}
```

## Migracion

La migracion SQL esta en:

```text
db/migrations/20260613_ai_empresarial.sql
```

El servicio tambien asegura las tablas al arrancar:

- `ai_conversations`
- `ai_messages`
- `ai_tool_logs`

## Prueba rapida

1. Configurar `OPENAI_API_KEY` en `.env`.
2. Iniciar el sistema con `npm start`.
3. Entrar con un usuario autenticado.
4. Asegurar que el usuario tenga permiso `ai_empresarial:view`.
5. Abrir `/ai`.
6. Probar consultas:
   - `Muestrame las ventas de este mes.`
   - `Que facturas estan pendientes?`
   - `Busca el paquete 12345.`
   - `Cuanto inventario tengo disponible?`
   - `Que proyectos estan atrasados?`
   - `Redacta un correo profesional para solicitar pago.`

## Auditoria

Cada herramienta ejecutada registra:

- usuario (`executed_by`)
- empresa (`company_id`)
- fecha (`created_at`)
- herramienta (`tool_name`)
- parametros (`parameters`)
- resultado (`result`)
- tiempo de ejecucion (`execution_ms`)
