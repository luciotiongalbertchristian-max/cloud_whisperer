<?php
/**
 * Weather Detector - configuration.
 *
 * This file only defines constants and prints nothing. It is also blocked
 * from direct browser access by .htaccess.
 */

// ---- MySQL (must match database/schema.sql) ---------------------------
const DB_HOST = '127.0.0.1';          // MySQL stays bound to localhost
const DB_PORT = 3306;
const DB_NAME = 'weather_detector';
const DB_USER = 'weather_app';
const DB_PASS = 'Delucios2004'; // <-- change, and change it in MySQL too

// ---- Security ---------------------------------------------------------
// The Arduino sends this value in the "X-API-Key" HTTP header.
// It must be identical to API_KEY in the .ino sketch.
// Set to '' (empty string) to disable the check.
const API_KEY = 'Delucios2004';

// ---- Time -------------------------------------------------------------
const APP_TIMEZONE   = 'Asia/Manila';  // all stored timestamps use this zone
const MYSQL_TZ_OFFSET = '+08:00';      // Manila has no DST, so a fixed offset is exact

// ---- History endpoint -------------------------------------------------
const HISTORY_DEFAULT_LIMIT = 300;
const HISTORY_MAX_LIMIT     = 5000;

// ---- Data retention ---------------------------------------------------
// At 1 reading/second the table grows by ~86,400 rows per day.
// Set to a number of days to automatically delete older rows, or 0 to keep everything.
const RETENTION_DAYS = 0;

// ---- Debugging --------------------------------------------------------
// true  = include the technical database error text in JSON error replies.
// false = return a generic message (details still go to the Apache error log).
const DEBUG = false;
