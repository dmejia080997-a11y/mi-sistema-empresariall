# WhatsApp Oficial

Este modulo usa WhatsApp Business Cloud API oficial de Meta. Cada empresa debe configurar su propia cuenta desde `WhatsApp Oficial > Configuracion`; las consultas del modulo siempre se filtran por `company_id`.

## 1. Crear app en Meta Developers

1. Entra a https://developers.facebook.com/apps/.
2. Crea una app de tipo Business.
3. Agrega el producto WhatsApp.
4. Asocia la app al Business Manager correcto.
5. En produccion, completa verificacion de negocio, permisos y configuracion de pago cuando Meta lo solicite.

## 2. Obtener `phone_number_id`

1. En Meta Developers abre la app.
2. Ve a `WhatsApp > API Setup`.
3. Selecciona el numero de WhatsApp Business.
4. Copia el valor `Phone number ID`.
5. Pegalo en `Phone Number ID` dentro de la configuracion del modulo.

## 3. Obtener `whatsapp_business_account_id`

1. En `WhatsApp > API Setup` revisa el campo `WhatsApp Business Account ID`.
2. Tambien puede verse en Business Manager, dentro de la cuenta de WhatsApp.
3. Pegalo en `WhatsApp Business Account ID`.

## 4. Configurar webhook

El endpoint del sistema es:

```text
GET /webhooks/whatsapp
POST /webhooks/whatsapp
```

La URL publica debe usar HTTPS, por ejemplo:

```text
https://tu-dominio.com/webhooks/whatsapp
```

En Meta Developers, ve a `WhatsApp > Configuration` y agrega esa URL en `Callback URL`.

## 5. Colocar URL del webhook

En el modulo, guarda la URL publica en `Webhook URL publica`. Ese campo es referencia operativa para administradores; Meta usara la URL configurada en Developers.

## 6. Configurar token de verificacion

1. En el modulo genera o escribe un `Webhook verify token`.
2. Guarda la configuracion.
3. En Meta Developers pega exactamente el mismo token.
4. Meta llamara `GET /webhooks/whatsapp` con `hub.mode`, `hub.verify_token` y `hub.challenge`.
5. Si el token coincide con una empresa configurada, el sistema responde el `hub.challenge`.

## 7. Probar envio de mensajes

1. Guarda un `access_token`, `phone_number_id` y estado `connected`.
2. Abre una conversacion existente.
3. Envia un texto desde la bandeja.
4. El sistema llama:

```text
POST https://graph.facebook.com/v19.0/{phone_number_id}/messages
```

El token se guarda cifrado cuando existe `WHATSAPP_TOKEN_SECRET`, `FILE_TOKEN_SECRET` o `SESSION_SECRET`. El token completo no se muestra en pantalla.

## 8. Probar recepcion de mensajes

1. En Meta Developers suscribe el webhook a eventos de WhatsApp, especialmente `messages`.
2. Escribe al numero conectado desde un WhatsApp de prueba.
3. Meta enviara un `POST /webhooks/whatsapp`.
4. El sistema detecta la empresa por `phone_number_id`, crea contacto/conversacion si no existen, guarda el mensaje y aumenta el contador no leido.

## 9. Configurar plantillas

1. Crea plantillas en WhatsApp Manager o desde las herramientas de Meta.
2. Espera que queden aprobadas.
3. Registra en el modulo el `template_name`, idioma, categoria, estado y cuerpo.
4. Desde la bandeja selecciona la plantilla y envia.

El envio de plantilla usa:

```json
{
  "messaging_product": "whatsapp",
  "to": "numero_destino",
  "type": "template",
  "template": {
    "name": "nombre_template",
    "language": {
      "code": "es"
    }
  }
}
```

## 10. Limitaciones de la ventana de 24 horas

WhatsApp permite mensajes libres solo dentro de las 24 horas posteriores al ultimo mensaje recibido del cliente. Fuera de esa ventana se debe enviar una plantilla aprobada por Meta.

El modulo bloquea el envio libre si la conversacion no tiene un ultimo mensaje entrante reciente y guarda el mensaje como `failed` con el motivo. Para reactivar la conversacion fuera de la ventana, usa `Enviar plantilla`.

## Seguridad operativa

- No imprimir tokens en logs.
- Usar HTTPS para el webhook.
- Crear un token de acceso permanente o de sistema siguiendo las politicas de Meta.
- Revisar permisos por rol: Admin configura API, Supervisor ve/asigna/responde, Agente responde solo chats asignados, Usuario normal requiere permiso explicito.
- Verificar que cada empresa tenga su propio `phone_number_id`.
