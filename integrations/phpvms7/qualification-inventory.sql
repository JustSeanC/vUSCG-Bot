-- Read-only inventory, using a read-only staging database account.
START TRANSACTION READ ONLY;
SELECT id, name FROM awards ORDER BY id;
SELECT id, name FROM roles ORDER BY id;
SELECT id, name, type, active FROM typeratings ORDER BY id;
SELECT id, name FROM ranks WHERE id IN (12, 13, 14, 15, 16, 17);
SELECT award_id, COUNT(*) AS assignments FROM user_awards GROUP BY award_id ORDER BY award_id;
SELECT role_id, COUNT(*) AS assignments FROM role_user GROUP BY role_id ORDER BY role_id;
SELECT typerating_id, COUNT(*) AS assignments FROM typerating_user GROUP BY typerating_id ORDER BY typerating_id;
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('awards','roles','user_awards','role_user','typeratings','typerating_user')
  ORDER BY TABLE_NAME, ORDINAL_POSITION;
COMMIT;
