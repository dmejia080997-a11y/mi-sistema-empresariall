# Arquitectura y Fases de Reestructuracion

## Objetivo
Reducir complejidad, separar responsabilidades y mantener estabilidad funcional en cada cambio.

## Estado Actual
- `server.js` centraliza configuracion, middlewares, utilidades, acceso a DB y rutas.
- La app funciona, pero cuesta mantener y extender por el acoplamiento.

## Base Modular Introducida
- `src/core/security-headers.js`: cabeceras HTTP de seguridad.
- `src/core/session-config.js`: configuracion de cookie/sesion.
- `src/core/rate-limiter.js`: rate limiting en memoria reutilizable.
- `src/modules/auth/routes.js`: rutas de autenticacion y sesion.
- `src/modules/companies/routes.js`: rutas de gestion de empresas (creacion, detalle, acceso master, estado, credenciales).
- `src/modules/packages/routes.js`: rutas de paquetes (dashboard, listado, estado, etiquetas, adjuntos, exportacion, tracking).
- `src/modules/customers/routes.js`: rutas de clientes, consignatarios, portal cliente, tracking publico e integracion SAT.
- `src/modules/carrier-reception/routes.js`: rutas de recepcion de paqueteria por transportista (quick, list, summary, detail, export y cancelacion).
- `src/modules/inventory/routes.js`: rutas de inventario (items, import/export CSV, categorias y marcas).
- `src/modules/accounting/routes.js`: rutas de contabilidad (configuracion, categorias/reglas, cuentas, diario, reportes y exportaciones).
- `src/modules/logistics/routes.js`: rutas de logistica aduanera y aerea (`cuscar`, `manifests`, `airway-bills`).
- `src/modules/invoices/routes.js`: rutas de facturacion (`invoices`, detalle y creacion de factura).
- `src/modules/agenda-medica/routes.js`: agenda medica (vista principal + API de citas y doctores).
- `src/modules/users/routes.js`: gestion de usuarios (alta, actualizacion, eliminacion y permisos).
- `src/modules/audit/routes.js`: bitacora de auditoria (`/audit`).
- `src/modules/master-activities/routes.js`: CRUD de actividades de negocio en panel master.
- `src/modules/master/routes.js`: dashboard principal master (`/master`).
- `src/modules/master-auth/routes.js`: autenticacion master (`/master/login`, `/master/logout`).
- `src/modules/master-companies/routes.js`: gestion global de empresas en panel master (`/master/create-company`, `/master/companies/*`).

## Estructura Objetivo (Faseada)
- `src/config/`: variables de entorno, rutas de archivos, constantes globales.
- `src/core/`: seguridad, sesion, logger, errores comunes.
- `src/data/`: acceso a sqlite y helpers DB.
- `src/modules/auth/`: login, logout, master login.
- `src/modules/companies/`: empresas y gestion master.
- `src/modules/packages/`: paquetes, tracking, adjuntos.
- `src/modules/invoices/`: facturacion y pagos.
- `src/modules/accounting/`: cuentas, diario, reportes.

## Regla de Trabajo
Cada fase debe cumplir:
1. No romper rutas existentes.
2. Mantener salida de vistas y flujos actuales.
3. Pasar `npm test` y `node --check`.

## Siguiente Paso Recomendado
Extraer el siguiente dominio de alto impacto: `middleware global` (manejo de errores/CSRF y cierre de bootstrap), para reducir responsabilidades directas en `server.js`.
