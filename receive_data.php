<?php
declare(strict_types=1);

/**
 * receive_data.php
 *
 * Receives one sensor reading from the Arduino as a JSON HTTP POST,
 * validates it, and stores it in MySQL with an Asia/Manila timestamp.
 *
 * Expected request:
 *   POST /weather_detector/receive_data.php
 *   Content-Type: application/json
 *   X-API-Key: <API_KEY from config.php>
 *
 *   {
 *     "device": "uno-r4-weather-01",
 *     "temperatureC": 28.40,
 *     "humidityPct": 71.00,
 *     "rainRaw": 3120,
 *     "gasRaw": 640,
 *     "pressureHpa": 1009.82,
 *     "altitudeM": 18.40,
 *     "bmp180Available": true,
 *     "uptimeSeconds": 123
 *   }
 *
 * Replies (always JSON):
 *   200  {"success":true,"id":123,"recordedAt":"2026-10-16T14:03:22+08:00"}
 *   400  malformed / empty JSON          401 missing or wrong API key
 *   405  not a POST                      413 body too large
 *   422  validation failed (details[] lists each problem)
 *   500  database error
 */

require_once __DIR__ . '/lib.php';

const MAX_BODY_BYTES = 4096;
const ADC_MAX        = 16383;   // up to 14-bit ADC on the UNO R4

// ---- 1. Method ---------------------------------------------------------
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    send_json(405, ['success' => false, 'error' => 'Method not allowed. Use HTTP POST with a JSON body.']);
}

// ---- 2. API key (optional) --------------------------------------------
if (API_KEY !== '') {
    $provided = (string)($_SERVER['HTTP_X_API_KEY'] ?? '');
    if (!hash_equals(API_KEY, $provided)) {
        send_json(401, ['success' => false, 'error' => 'Missing or invalid API key (X-API-Key header).']);
    }
}

// ---- 3. Read and decode the body --------------------------------------
$raw = file_get_contents('php://input');
if ($raw === false || $raw === '') {
    send_json(400, ['success' => false, 'error' => 'Empty request body. Expected a JSON object.']);
}
if (strlen($raw) > MAX_BODY_BYTES) {
    send_json(413, ['success' => false, 'error' => 'Request body too large.']);
}

try {
    $data = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    send_json(400, ['success' => false, 'error' => 'Invalid JSON: ' . $e->getMessage()]);
}
if (!is_array($data) || array_is_list($data)) {
    send_json(400, ['success' => false, 'error' => 'JSON body must be an object, e.g. {"temperatureC": 25.0, ...}']);
}

// ---- 4. Validate -------------------------------------------------------
function is_number(mixed $v): bool
{
    return is_int($v) || is_float($v);
}

function is_whole(mixed $v): bool
{
    return is_int($v) || (is_float($v) && floor($v) === $v);
}

$errors = [];

/** Require a numeric field inside [min, max]. */
$requireNumber = function (string $key, float $min, float $max, bool $whole = false) use ($data, &$errors): void {
    if (!array_key_exists($key, $data)) {
        $errors[] = "Missing field: $key";
        return;
    }
    $v = $data[$key];
    if (!is_number($v) || ($whole && !is_whole($v))) {
        $errors[] = "$key must be " . ($whole ? 'a whole number' : 'a number');
        return;
    }
    if ($v < $min || $v > $max) {
        $errors[] = "$key out of range ($min to $max)";
    }
};

// device: required short string (logged for diagnostics, not stored)
if (!isset($data['device']) || !is_string($data['device']) || $data['device'] === '' || strlen($data['device']) > 64) {
    $errors[] = 'device must be a non-empty string (max 64 characters)';
}

$requireNumber('temperatureC', -40, 125);
$requireNumber('humidityPct', 0, 100);
$requireNumber('rainRaw', 0, ADC_MAX, true);
$requireNumber('gasRaw', 0, ADC_MAX, true);
$requireNumber('uptimeSeconds', 0, 4294967295, true);

// bmp180Available: required boolean
$bmpAvailable = false;
if (!array_key_exists('bmp180Available', $data) || !is_bool($data['bmp180Available'])) {
    $errors[] = 'bmp180Available must be true or false';
} else {
    $bmpAvailable = $data['bmp180Available'];
}

// pressure/altitude: only validated (and stored) when the BMP180 works
if ($bmpAvailable) {
    $requireNumber('pressureHpa', 300, 1100);
    $requireNumber('altitudeM', -500, 9000);
} else {
    foreach (['pressureHpa', 'altitudeM'] as $k) {
        if (!array_key_exists($k, $data)) {
            $errors[] = "Missing field: $k";
        }
    }
}

if ($errors) {
    send_json(422, ['success' => false, 'error' => 'Validation failed', 'details' => $errors]);
}

// ---- 5. Insert ---------------------------------------------------------
$recordedAt = new DateTimeImmutable('now', new DateTimeZone(APP_TIMEZONE));

try {
    $stmt = db()->prepare(
        'INSERT INTO readings
            (recorded_at, temperature_c, humidity_pct, rain_raw, gas_raw,
             pressure_hpa, altitude_m, bmp180_available)
         VALUES
            (:recorded_at, :temperature_c, :humidity_pct, :rain_raw, :gas_raw,
             :pressure_hpa, :altitude_m, :bmp180_available)'
    );

    $stmt->bindValue(':recorded_at', $recordedAt->format('Y-m-d H:i:s'));
    $stmt->bindValue(':temperature_c', (float)$data['temperatureC']);
    $stmt->bindValue(':humidity_pct', (float)$data['humidityPct']);
    $stmt->bindValue(':rain_raw', (int)$data['rainRaw'], PDO::PARAM_INT);
    $stmt->bindValue(':gas_raw', (int)$data['gasRaw'], PDO::PARAM_INT);
    $stmt->bindValue(':pressure_hpa', $bmpAvailable ? (float)$data['pressureHpa'] : null, $bmpAvailable ? PDO::PARAM_STR : PDO::PARAM_NULL);
    $stmt->bindValue(':altitude_m', $bmpAvailable ? (float)$data['altitudeM'] : null, $bmpAvailable ? PDO::PARAM_STR : PDO::PARAM_NULL);
    $stmt->bindValue(':bmp180_available', $bmpAvailable ? 1 : 0, PDO::PARAM_INT);
    $stmt->execute();

    $newId = (int)db()->lastInsertId();

    // Optional housekeeping: roughly once per 500 requests, drop rows older than RETENTION_DAYS.
    if (RETENTION_DAYS > 0 && random_int(1, 500) === 1) {
        try {
            $cutoff = $recordedAt->modify('-' . RETENTION_DAYS . ' days')->format('Y-m-d H:i:s');
            $del = db()->prepare('DELETE FROM readings WHERE recorded_at < :cutoff');
            $del->execute([':cutoff' => $cutoff]);
        } catch (Throwable $e) {
            error_log('[weather_detector] retention cleanup failed: ' . $e->getMessage());
        }
    }

    send_json(200, [
        'success'    => true,
        'id'         => $newId,
        'recordedAt' => $recordedAt->format('c'),   // ISO 8601, e.g. 2026-10-16T14:03:22+08:00
    ]);
} catch (Throwable $e) {
    send_json(500, db_error_payload($e));
}
