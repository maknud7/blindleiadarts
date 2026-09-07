<?php
declare(strict_types=1);

$text = trim((string)($_GET['text'] ?? ''));
if ($text === '' || strlen($text) > 2048) {
    http_response_code(400);
    header('Content-Type: image/svg+xml; charset=utf-8');
    echo '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420"><rect width="420" height="420" fill="white"/><text x="210" y="210" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#111">Ugyldig pairingkode</text></svg>';
    exit;
}

header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');

$upstream = 'https://quickchart.io/qr?size=420&margin=2&format=svg&text=' . rawurlencode($text);
$body = false;
$status = 0;

if (function_exists('curl_init')) {
    $ch = curl_init($upstream);
    if ($ch !== false) {
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT_MS => 1500,
            CURLOPT_TIMEOUT_MS => 3000,
            CURLOPT_USERAGENT => 'BlindleiaDarts-KioskQR/1.0',
        ]);
        $body = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
    }
}

if (is_string($body) && $body !== '' && $status >= 200 && $status < 300 && str_contains($body, '<svg')) {
    header('Content-Type: image/svg+xml; charset=utf-8');
    echo $body;
    exit;
}

// The QR provider is deliberately not allowed to break the kiosk UI. If it is
// unavailable, return a same-origin HTTP 200 SVG that clearly exposes the
// pairing code so the admin can enter it manually.
$code = '';
$query = parse_url($text, PHP_URL_QUERY);
if (is_string($query)) {
    parse_str($query, $params);
    $code = strtoupper(trim((string)($params['pairing'] ?? '')));
}
if (!preg_match('/^[A-Z0-9]{4,12}$/', $code)) {
    $code = 'SE KODEN UNDER';
}
$safeCode = htmlspecialchars($code, ENT_QUOTES | ENT_XML1, 'UTF-8');

header('Content-Type: image/svg+xml; charset=utf-8');
echo '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420" viewBox="0 0 420 420">'
    . '<rect width="420" height="420" rx="24" fill="#fff"/>'
    . '<rect x="16" y="16" width="388" height="388" rx="20" fill="none" stroke="#d5dde4" stroke-width="2"/>'
    . '<text x="210" y="155" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" fill="#53606b">QR midlertidig utilgjengelig</text>'
    . '<text x="210" y="215" text-anchor="middle" font-family="system-ui,sans-serif" font-size="42" font-weight="700" letter-spacing="3" fill="#101820">' . $safeCode . '</text>'
    . '<text x="210" y="265" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16" fill="#53606b">Skriv inn koden i Utstyr</text>'
    . '</svg>';
