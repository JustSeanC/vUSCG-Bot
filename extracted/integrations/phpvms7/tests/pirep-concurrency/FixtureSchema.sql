CREATE TABLE users (id INT PRIMARY KEY, rank_id INT, flight_time INT, flights INT,
    transfer_time INT DEFAULT 0, curr_airport_id VARCHAR(4), last_pirep_id VARCHAR(30), state INT DEFAULT 1) ENGINE=InnoDB;
CREATE TABLE aircraft (id INT PRIMARY KEY, flight_time INT, airport_id VARCHAR(4), landing_time DATETIME,
    fuel_onboard INT, mtow INT, icao VARCHAR(8), status CHAR(1)) ENGINE=InnoDB;
CREATE TABLE ranks (id INT PRIMARY KEY, name VARCHAR(30), hours INT, auto_promote BOOLEAN,
    auto_approve_acars BOOLEAN, auto_approve_manual BOOLEAN) ENGINE=InnoDB;
CREATE TABLE pireps (id VARCHAR(30) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, user_id INT NOT NULL,
    aircraft_id INT, state INT, status VARCHAR(8), source INT, flight_time INT, block_fuel INT,
    fuel_used INT, planned_flight_time INT DEFAULT 0, score INT DEFAULT 100, landing_rate INT DEFAULT 0,
    arr_airport_id VARCHAR(4), route VARCHAR(128) NULL, block_on_time DATETIME, submitted_at DATETIME,
    created_at DATETIME, updated_at DATETIME, deleted_at DATETIME) ENGINE=InnoDB;
CREATE TABLE acars (id INT PRIMARY KEY AUTO_INCREMENT, pirep_id VARCHAR(30), type INT) ENGINE=InnoDB;
CREATE TABLE roles (id INT PRIMARY KEY, name VARCHAR(40)) ENGINE=InnoDB;
CREATE TABLE role_user (role_id INT, user_id INT) ENGINE=InnoDB;
CREATE TABLE pirep_comments (id INT PRIMARY KEY AUTO_INCREMENT, pirep_id VARCHAR(30), user_id INT,
    comment VARCHAR(200), created_at DATETIME, updated_at DATETIME, deleted_at DATETIME) ENGINE=InnoDB;
CREATE TABLE pirep_field_values (id INT PRIMARY KEY AUTO_INCREMENT, pirep_id VARCHAR(30), name VARCHAR(30),
    slug VARCHAR(50), value VARCHAR(100), source INT, deleted_at DATETIME) ENGINE=InnoDB;
CREATE TABLE pirep_fares (id INT PRIMARY KEY AUTO_INCREMENT, pirep_id VARCHAR(30), deleted_at DATETIME) ENGINE=InnoDB;
CREATE TABLE simbrief (id INT PRIMARY KEY AUTO_INCREMENT, pirep_id VARCHAR(30), deleted_at DATETIME) ENGINE=InnoDB;
CREATE TABLE awards (id INT PRIMARY KEY, active BOOLEAN) ENGINE=InnoDB;
CREATE TABLE fixture_awards (user_id INT, award_id INT, PRIMARY KEY (user_id, award_id)) ENGINE=InnoDB;
CREATE TABLE fixture_journal (pirep_id VARCHAR(30) PRIMARY KEY, amount INT) ENGINE=InnoDB;
CREATE TABLE fixture_events (id INT PRIMARY KEY AUTO_INCREMENT, kind VARCHAR(12), pirep_id VARCHAR(30)) ENGINE=InnoDB;
CREATE TABLE fixture_external (id INT PRIMARY KEY AUTO_INCREMENT, kind VARCHAR(12), pirep_id VARCHAR(30)) ENGINE=InnoDB;
