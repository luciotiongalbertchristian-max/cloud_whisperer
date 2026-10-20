<?php
declare(strict_types=1);

/**
 * Shared helpers used by receive_data.php and history.php.
 * Not meant to be opened in a browser (blocked by .htaccess).
 */

require_once __DIR__ . '/config.php';

// Every date()/DateTime call in the app now uses Philippine time.
date_default_timezone_set(APP_TIMEZONE);

// Never let PHP warnings leak into the JSON body (they would break the dashboard).
ini_set('display_errors', '0');

/**
 * Send a JSON response and stop the script.
 */
function send_json(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

/**
 * Build the error payload for a failed database operation.
 * The real message is always logged; it is only shown to the client when DEBUG is on.
 */
function db_error_payload(Throwable $e): array
{
    error_log('[weather_detector] DB error: ' . $e->getMessage());
    $payload = [
        'success' => false,
        'error'   => 'Database error. Check that MySQL is running and the credentials in config.php are correct.',
    ];
    if (DEBUG) {
        $payload['debug'] = $e->getMessage();
    }
    return $payload;
}

/**
 * Lazily create one PDO connection per request.
 * Throws PDOException if MySQL is down or the credentials are wrong.
 */
function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        DB_HOST,
        DB_PORT,
        DB_NAME
    );

    $pdo = new PDO($dsn, DB_USER, DB_PASS, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,   // real prepared statements
        PDO::ATTR_TIMEOUT            => 3,       // fail fast if MySQL is unreachable
    ]);

    // Make NOW()/CURRENT_TIMESTAMP on this connection agree with Asia/Manila too.
    $pdo->exec("SET time_zone = '" . MYSQL_TZ_OFFSET . "'");

    return $pdo;
}
