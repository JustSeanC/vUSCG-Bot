CREATE TABLE IF NOT EXISTS vuscg_pirep_review_nonces (
    nonce CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    expires_at BIGINT NOT NULL,
    INDEX vuscg_pirep_review_nonces_expiry (expires_at)
) ENGINE=InnoDB;
