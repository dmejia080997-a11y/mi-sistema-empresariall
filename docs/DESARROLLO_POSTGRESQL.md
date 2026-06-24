# Desarrollo local con PostgreSQL

El entorno local usa dos bases:

- master: `mi_sistema_dev`
- tenant: `empresa_cf_multi_services_dev`

La aplicación carga `.env.development` cuando `NODE_ENV=development` o cuando
`NODE_ENV` no está definido. En ese modo rechaza conexiones que no apunten a
`localhost`, `127.0.0.1` o `::1`, y también rechaza una base master distinta de
`mi_sistema_dev`. Esto impide usar accidentalmente PostgreSQL de producción.

## Requisitos

1. PostgreSQL local en ejecución.
2. El usuario configurado debe poder ejecutar `CREATE DATABASE` y `DROP DATABASE`.
3. Para refrescar datos: `psql`, `pg_restore` y `pg_dump` disponibles en `PATH`.
4. Ajustar usuario y contraseña en `.env.development` si no son
   `postgres:postgres`.

No copie `DATABASE_URL` de producción a `.env.development`.

## Preparar el entorno por primera vez

```bash
npm run dev:setup
```

El comando es idempotente:

1. valida que la conexión sea local;
2. crea `mi_sistema_dev`;
3. crea `empresa_cf_multi_services_dev`;
4. instala el esquema base si las bases están vacías;
5. registra el tenant local en `companies`.

Después puede iniciar la aplicación:

```bash
npm run dev
```

## Refrescar desde el último dump

Coloque un archivo `backup-all-*.tar.gz` o `.zip` en
`storage/backups/postgres/`. Debe contener el dump master y el dump tenant
generados por `npm run backup:all`.

```bash
npm run dev:refresh
```

El comando:

1. selecciona el backup más reciente;
2. recrea únicamente las dos bases locales;
3. importa master y tenant;
4. reemplaza las referencias de bases productivas en `companies`;
5. registra `empresa_cf_multi_services_dev`;
6. ejecuta `npm run migrate:safe`.

`dev:refresh` elimina y recrea las dos bases locales. No conserva cambios
locales que no estén en el dump.

Para indicar otro archivo:

```dotenv
DEV_DUMP_PATH=C:\backups\backup-all-20260623-120000.tar.gz
```

Si el backup contiene varios tenants, indique el nombre original:

```dotenv
DEV_TENANT_SOURCE_DATABASE=empresa_cf_multi_services
```

## Verificación

```bash
npm run db:active
npm run migrate:status
npm run tenants:check
```

La salida activa debe mostrar `mi_sistema_dev`, y el tenant registrado debe ser
`empresa_cf_multi_services_dev`.

## Fallos comunes

- `ECONNREFUSED`: PostgreSQL local no está iniciado.
- autenticación fallida: corrija usuario o contraseña en `.env.development`.
- `CREATE DATABASE cannot run`: el usuario no tiene privilegio `CREATEDB`.
- `pg_restore` o `pg_dump` no encontrado: agregue la carpeta `bin` de PostgreSQL
  al `PATH`.
- conexión rechazada por seguridad: revise que `NODE_ENV=development`,
  `DATABASE_SSL=false`, host local y base `mi_sistema_dev`.
