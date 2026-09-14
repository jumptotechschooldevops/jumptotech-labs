-- BETA-P0-013 restore drill: a deterministic description of one database.
--
-- Two databases that print the same lines hold the same rows in every public
-- table, the same schema (columns, defaults, indexes, constraints), the same
-- sequence positions and the same migration ledger. Reads only.
--
--   table <name> <row count> <md5 of every row, sorted>
--   sequence <name> <last value>
--   schema <md5 of columns, indexes and constraints>
--   migration <version> <checksum>
--   known <student> <display name> <completed>/<labs>

SELECT 'table ' || c.relname || ' '
       || (xpath('/row/n/text()',
                 query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
       || ' '
       || (xpath('/row/h/text()',
                 query_to_xml(format('SELECT md5(coalesce(string_agg(r::text, E''\n'' ORDER BY r::text), '''')) AS h FROM public.%I AS r',
                                     c.relname), false, true, '')))[1]::text
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

SELECT 'sequence ' || sequencename || ' ' || coalesce(last_value::text, 'unused')
  FROM pg_sequences
 WHERE schemaname = 'public'
 ORDER BY sequencename;

SELECT 'schema ' || md5(string_agg(line, E'\n' ORDER BY line))
  FROM (
    SELECT format('column %s.%s %s %s %s', table_name, column_name, data_type, is_nullable, coalesce(column_default, '')) AS line
      FROM information_schema.columns
     WHERE table_schema = 'public'
    UNION ALL
    SELECT format('index %s', indexdef)
      FROM pg_indexes
     WHERE schemaname = 'public'
    UNION ALL
    SELECT format('constraint %s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid))
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
  ) AS definitions;

SELECT 'migration ' || version || ' ' || checksum
  FROM schema_migrations
 ORDER BY version;

SELECT 'known ' || s.student_id || ' ' || s.display_name || ' '
       || count(*) FILTER (WHERE p.status = 'COMPLETED') || '/' || count(*)
  FROM students AS s
  JOIN lab_progress AS p USING (student_id)
 WHERE s.student_id = 'drill-student-003'
 GROUP BY s.student_id, s.display_name;
