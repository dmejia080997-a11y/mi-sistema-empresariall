# Centro de Mensajes / Meta Inbox

Este modulo usa unicamente APIs oficiales de Meta:

- Meta Graph API
- Messenger Platform
- Page API
- Webhooks oficiales

No usa WhatsApp Web, QR, scraping ni automatizacion de navegador.

## Variables de entorno

Configura:

```env
META_APP_ID=tu_app_id
META_APP_SECRET=tu_app_secret
META_VERIFY_TOKEN=un_token_largo_y_privado
META_GRAPH_VERSION=v19.0
META_TOKEN_SECRET=clave_larga_para_cifrar_tokens
META_REDIRECT_URI=
META_OAUTH_SCOPES=pages_show_list,pages_manage_metadata,pages_messaging,pages_read_engagement,pages_manage_engagement,leads_retrieval
META_SUBSCRIBED_FIELDS=messages,messaging_postbacks,feed,leadgen
BASE_URL=https://MI-DOMINIO.com
```

`META_TOKEN_SECRET` cifra tokens con AES-256-GCM. Si no existe, el sistema intenta usar `FILE_TOKEN_SECRET` o `SESSION_SECRET`.

`META_REDIRECT_URI` es opcional. Si se deja vacio, el sistema usa:

```text
{BASE_URL}/meta-inbox/oauth/callback
```

Ese valor debe estar registrado exactamente igual en Facebook Login > Valid OAuth Redirect URIs.

## Configuracion en Meta Developers

1. Crea una app en Meta Developers.
2. Agrega Messenger Platform.
3. Agrega Webhooks.
4. Agrega Facebook Login for Business o Facebook Login y registra el OAuth Redirect URI que muestra `Meta Inbox > Configuracion`.
5. Configura Callback URL:

```text
https://MI-DOMINIO.com/webhooks/meta
```

6. Configura Verify Token con el mismo valor de `META_VERIFY_TOKEN`.
7. Suscribe paginas a los campos necesarios:
   - `messages`
   - `messaging_postbacks`
   - `feed`
   - `leadgen`
8. Solicita permisos para produccion:
   - `pages_show_list`
   - `pages_manage_metadata`
   - `pages_messaging`
   - `pages_read_engagement`
   - `pages_manage_engagement`
   - `leads_retrieval`

Algunos permisos requieren App Review de Meta antes de usarlos con clientes reales.

## Flujo operativo

1. Entra a `Meta Inbox > Configuracion`.
2. Presiona `Conectar con Facebook`.
3. Inicia sesion con el perfil que administra la pagina de Facebook.
4. Acepta los permisos solicitados.
5. Activa las paginas que la empresa usara.
6. En Meta Developers, suscribe esas paginas a la app/webhook.
7. Los eventos entrantes se guardan en `meta_webhook_events` y crean conversaciones en `conversations`.

La opcion de token manual sigue disponible como respaldo tecnico.

## Seguridad

- El endpoint `POST /webhooks/meta` valida `X-Hub-Signature-256` con `META_APP_SECRET`.
- Los tokens se guardan cifrados en `meta_connections` y `meta_pages`.
- La interfaz no muestra tokens completos.
- Los webhooks responden rapido y procesan eventos despues del `200`.

## Prueba de conexion

Con un token oficial:

```powershell
$env:META_TEST_TOKEN="EAAB..."
node tools/meta-inbox-test-connection.js
```

Tambien puedes pasar el token como argumento:

```powershell
node tools/meta-inbox-test-connection.js "EAAB..."
```
