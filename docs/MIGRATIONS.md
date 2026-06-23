# Migraciones PostgreSQL multi-tenant

Este proyecto usa migraciones SQL separadas:

- `migrations/master/`: cambios exclusivos de la base master indicada por `DATABASE_URL`.
- `migrations/tenants/`: cambios que deben aplicarse en cada base indicada por `companies.database_name`.

Cada base mantiene su propio registro en `schema_migrations`. El sistema compara el
nombre y SHA-256 de cada archivo, por lo que una migración aplicada no vuelve a
ejecutarse y tampoco puede modificarse silenciosamente.

## Crear una migración

```bash
npm run migrate:create -- agregar_plan_compania
```

El comando crea dos archivos con el mismo timestamp:

```text
migrations/master/YYYYMMDDHHMMSS_agregar_plan_compania.sql
migrations/tenants/YYYYMMDDHHMMSS_agregar_plan_compania.sql
```

Edite solamente el archivo del alcance necesario. El otro puede quedar únicamente
con comentarios y se registrará como aplicado sin cambiar el esquema.

Ejemplos seguros:

```sql
ALTER TABLE companies
ADD COLUMN IF NOT EXISTS plan VARCHAR(50);

CREATE TABLE IF NOT EXISTS global_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_status
ON companies(status);
```

Las migraciones deben ser idempotentes. Use `IF EXISTS`, `IF NOT EXISTS`,
restricciones con nombres conocidos y actualizaciones que puedan repetirse sin
duplicar o perder información.

## Probar en local

Configure `.env` con el `DATABASE_URL` local. Nunca copie el `DATABASE_URL` de
producción al entorno local.

```bash
npm run migrate:status
npm run migrate:safe
npm run migrate:status
```

`migrate:safe` siempre ejecuta `backup:all` antes de abrir una transacción de
migración. Si el backup falla, ninguna migración se ejecuta. Luego procesa primero
master y después cada base tenant, deteniéndose en el primer error.

Cada archivo se ejecuta en una transacción independiente. Un advisory lock evita
dos procesos de migración simultáneos sobre una misma base.

## Estado

```bash
npm run migrate:status
```

Muestra master y cada empresa con:

- `applied`: aplicada y checksum correcto.
- `pending`: archivo todavía no aplicado.
- `failed`: falló en el intento anterior y puede corregirse antes de reintentar.
- `checksum_mismatch`: se modificó un archivo ya aplicado; debe restaurarse y
  crearse una migración nueva.

El comando también informa registros cuyo archivo ya no existe. Los archivos de
migración aplicados no deben borrarse.

## Producción en Lightsail

Después de probar localmente, suba los archivos al repositorio. En Lightsail,
`update.sh` ejecuta:

```bash
npm run backup:all
git pull origin main
npm install
npm run migrate:safe
pm2 restart all --update-env
pm2 save
```

Hay dos backups intencionales: uno antes de actualizar el código y otro dentro de
`migrate:safe`, inmediatamente antes de migrar. PM2 solo reinicia si todos los
pasos anteriores terminan correctamente.

Las migraciones tenant también se aplican durante la creación de una empresa
nueva, para que su base nazca con el esquema vigente.

## Operaciones prohibidas

El validador detiene automáticamente migraciones que contengan:

- cualquier `DROP`;
- `TRUNCATE`;
- `DELETE FROM` sin `WHERE`;
- `ALTER COLUMN ... TYPE`;
- `RENAME COLUMN`.
- instrucciones manuales `BEGIN`, `COMMIT`, `ROLLBACK` o savepoints.

No intente evadir el validador. Cambios destructivos, conversiones de tipo y
renombres requieren un procedimiento manual: backup verificado, migración por
fases, copia de datos, validación y ventana de mantenimiento.

No modifique una migración después de aplicarla. Cree siempre un archivo nuevo.
No coloque secretos, cambios de uploads ni operaciones sobre archivos SQLite en
las migraciones.

## Recuperación desde backup

Si una migración falla, su transacción se revierte y queda registrada con estado
`failed`. Corrija el archivo si nunca fue aplicado correctamente y vuelva a
ejecutar `npm run migrate:safe`.

Si se necesita restaurar datos:

1. Detenga la aplicación con PM2 para evitar escrituras.
2. Identifique el archivo `storage/backups/postgres/backup-all-*.tar.gz`.
3. Extraiga el `.dump` de master o del tenant afectado.
4. Restaure primero en una base temporal con `pg_restore` y valide su contenido.
5. Restaure la base afectada siguiendo el procedimiento operativo y credenciales
   de PostgreSQL del servidor.
6. Ejecute `npm run migrate:status` antes de reiniciar PM2.

No restaure directamente sobre producción sin validar antes el dump en una base
temporal.
