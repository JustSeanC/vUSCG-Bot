-- Optional native sync adapter. Apply once only after verifying the staging schema.
-- Unique nullable markers preserve existing native associations and allow exact owned-row removal.
ALTER TABLE user_awards ADD COLUMN vuscg_qualification_owner CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_user_awards_vuscg_owner (vuscg_qualification_owner);
-- Run the role_user statement only after staging verification and before enabling IP role sync.
ALTER TABLE role_user ADD COLUMN vuscg_qualification_owner CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_role_user_vuscg_owner (vuscg_qualification_owner);
-- Run this statement only before enabling native type-rating synchronization.
ALTER TABLE typerating_user ADD COLUMN vuscg_qualification_owner CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_type_rating_vuscg_owner (vuscg_qualification_owner);
