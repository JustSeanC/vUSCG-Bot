-- Read-only on MySQL 5.7.44 and 8.4. Select the authorized isolated schema.
START TRANSACTION READ ONLY;
SELECT DATABASE() AS selected_schema, VERSION() AS server_version, @@session.time_zone AS session_zone,
  @@session.sql_mode AS sql_mode, @@session.foreign_key_checks AS foreign_key_checks,
  CASE
    WHEN DATABASE() IS NULL THEN 'STOP: select an authorized staging schema'
    WHEN VERSION() LIKE '%MariaDB%' THEN 'STOP: unsupported server'
    WHEN VERSION() REGEXP '^5[.]7[.]44(-|$)' THEN 'migrations/mysql57'
    WHEN VERSION() REGEXP '^8[.]4[.]' THEN 'migrations'
    ELSE 'STOP: unsupported server'
  END AS training_migration_path;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND (
  TABLE_NAME IN ('users','aircraft','pireps','ranks','discord_links','awards','user_awards',
                 'award_user','roles','role_user','typeratings','typerating_user')
  OR LEFT(TABLE_NAME, 6) = 'vuscg_' OR LEFT(TABLE_NAME, 9) = 'bot_cgas_')
ORDER BY TABLE_NAME;

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND (
  TABLE_NAME IN ('users','aircraft','pireps','ranks','discord_links','awards','user_awards',
                 'award_user','roles','role_user','typeratings','typerating_user')
  OR LEFT(TABLE_NAME, 6) = 'vuscg_' OR LEFT(TABLE_NAME, 9) = 'bot_cgas_')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND (
  TABLE_NAME IN ('users','aircraft','pireps','discord_links','user_awards','role_user','typerating_user')
  OR LEFT(TABLE_NAME, 6) = 'vuscg_' OR LEFT(TABLE_NAME, 9) = 'bot_cgas_')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE /*!80016 , ENFORCED */
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE() AND LEFT(TABLE_NAME, 6) = 'vuscg_'
ORDER BY TABLE_NAME, CONSTRAINT_NAME;
COMMIT;
