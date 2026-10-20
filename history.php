<?php
declare(strict_types=1);

/**
 * history.php
 *
 * Returns the most recent N readings as JSON, oldest first (ready for charting).
 *
 *   GET /weather_detector/history.php            -> last 300 rows
 *   GET /weather_detector/history.php?limit=60   -> last 60 rows (max HISTORY_MAX_LIMIT)
 *
 * Response:
 *   {
 *     "success": true,
 *     "count": 300,
 *     "limit": 300,
 *     "serverTime": "2026-10-16T14:03:22+08:00",
 *     "serverEpoch": 1792562602,
 *     "data": [
 *       { "id": 1, "recordedAt": "2026-10-16T14:00:01+08:00",
 *         "temperatureC": 28.4, "humidityPct": 71, "pressureHpa": 1009.82,
 *         "altitudeM": 18.4, "rainRaw": 3120, "gasRaw": 640,
 *         "bmp180Available": true }, ...
 *     ]
 *   }
 *
 * pressureHpa / altitudeM are null for rows where the BMP180 was not available.
 */

require_once __DIR__ . '/lib.php';

if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
    header('Allow: GET, HEAD');
    send_json(405, ['success' => false, 'error' => 'Method not allowed. Use HTTP GET.']);
}

// ---- limit parameter ---------------------------------------------------
$limit = HISTORY_DEFAULT_LIMIT;
if (isset($_GET['limit'])) {
    $parsed = filter_var($_GET['limit'], FILTER_VALIDATE_INT);
    if ($parsed !== false) {
        $limit = $parsed;
    }
}
$limit = max(1, min($limit, HISTORY_MAX_LIMIT));

// ---- query -------------------------------------------------------------
try {
    $stmt = db()->prepare(
        'SELECT id, recorded_at, temperature_c, humidity_pct, rain_raw, gas_raw,
                pressure_hpa, altitude_m, bmp180_available
           FROM readings
          ORDER BY id DESC
          LIMIT :limit'
    );
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();
    $rows = array_reverse($stmt->fetchAll());   // newest-first from SQL -> oldest-first for the chart
} catch (Throwable $e) {
    send_json(500, db_error_payload($e));
}

// ---- shape the output --------------------------------------------------
$tz = new DateTimeZone(APP_TIMEZONE);

$round = static fn($v): ?float => $v === null ? null : round((float)$v, 2);

$data = [];
foreach ($rows as $r) {
    // recorded_at is stored as Manila local time; attach the zone to get ISO 8601 with offset.
    $iso = (new DateTimeImmutable((string)$r['recorded_at'], $tz))->format('c');

    $data[] = [
        'id'              => (int)$r['id'],
        'recordedAt'      => $iso,
        'temperatureC'    => $round($r['temperature_c']),
        'humidityPct'     => $round($r['humidity_pct']),
        'pressureHpa'     => $round($r['pressure_hpa']),
        'altitudeM'       => $round($r['altitude_m']),
        'rainRaw'         => (int)$r['rain_raw'],
        'gasRaw'          => (int)$r['gas_raw'],
        'bmp180Available' => (bool)$r['bmp180_available'],
    ];
}

$now = new DateTimeImmutable('now', $tz);

send_json(200, [
    'success'     => true,
    'count'       => count($data),
    'limit'       => $limit,
    'serverTime'  => $now->format('c'),
    'serverEpoch' => $now->getTimestamp(),
    'data'        => $data,
]);
