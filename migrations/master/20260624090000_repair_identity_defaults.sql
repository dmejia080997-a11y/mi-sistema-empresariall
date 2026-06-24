DO $$
DECLARE
  target RECORD;
  sequence_name TEXT;
BEGIN
  FOR target IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()
      AND c.column_name = 'id'
      AND c.column_default IS NULL
      AND c.data_type IN ('smallint', 'integer', 'bigint')
  LOOP
    sequence_name := target.table_name || '_id_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', sequence_name);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN id SET DEFAULT nextval(%L)',
      target.table_name,
      sequence_name
    );
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 0) + 1, false)',
      sequence_name,
      target.table_name
    );
    EXECUTE format(
      'ALTER SEQUENCE %I OWNED BY %I.id',
      sequence_name,
      target.table_name
    );
  END LOOP;
END
$$;
