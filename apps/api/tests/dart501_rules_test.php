<?php

declare(strict_types=1);

use Blindleia\Dartkiosk\Api\Repository\ValidationException;
use Blindleia\Dartkiosk\Api\Service\Dart501Rules;

require dirname(__DIR__) . '/bootstrap.php';

$rules = new Dart501Rules();

$assert = static function (bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
};

$assert($rules->isCheckoutNumber(161), '161 must be a valid checkout.');
$assert(!$rules->isCheckoutNumber(159), '159 must not be a valid checkout.');
$assert(!$rules->isPossibleVisitScore(179), '179 must not be a possible three-dart score.');
$assert($rules->isPossibleVisitScore(180), '180 must be a possible three-dart score.');

$sumCheckout = $rules->evaluateVisit(161, [
    'input_mode' => 'sum',
    'score' => 161,
    'darts_used' => 3,
]);
$assert($sumCheckout['is_checkout'] === true, '161 sum checkout should finish the leg.');
$assert($sumCheckout['is_bust'] === false, '161 sum checkout must not bust.');
$assert($sumCheckout['remaining_after'] === 0, 'Checkout must leave zero.');

$impossibleCheckout = $rules->evaluateVisit(159, [
    'input_mode' => 'sum',
    'score' => 159,
    'darts_used' => 3,
]);
$assert($impossibleCheckout['is_bust'] === true, '159 checkout attempt must bust in sum mode.');
$assert($impossibleCheckout['remaining_after'] === 159, 'Bust must restore the previous score.');

$perDartCheckout = $rules->evaluateVisit(161, [
    'input_mode' => 'per_dart',
    'darts_used' => 3,
    'darts' => [
        ['multiplier' => 'T', 'value' => 20],
        ['multiplier' => 'T', 'value' => 17],
        ['multiplier' => 'D', 'value' => 'BULL'],
    ],
]);
$assert($perDartCheckout['score'] === 161, 'Per-dart 161 score must total correctly.');
$assert($perDartCheckout['is_checkout'] === true, 'T20 T17 DBULL must check out 161.');

$bust = $rules->evaluateVisit(40, [
    'input_mode' => 'per_dart',
    'darts_used' => 1,
    'darts' => [['multiplier' => 'T', 'value' => 20]],
]);
$assert($bust['is_bust'] === true, 'T20 on 40 must bust.');
$assert($bust['remaining_after'] === 40, 'Bust must restore 40.');

$invalidDartRejected = false;
try {
    $rules->evaluateVisit(501, [
        'input_mode' => 'per_dart',
        'darts_used' => 1,
        'darts' => [['multiplier' => 'D', 'value' => 21]],
    ]);
} catch (ValidationException) {
    $invalidDartRejected = true;
}
$assert($invalidDartRejected, 'D21 must be rejected.');

$extraDartRejected = false;
try {
    $rules->evaluateVisit(32, [
        'input_mode' => 'per_dart',
        'darts_used' => 2,
        'darts' => [
            ['multiplier' => 'D', 'value' => 16],
            ['multiplier' => 'S', 'value' => 0],
        ],
    ]);
} catch (ValidationException) {
    $extraDartRejected = true;
}
$assert($extraDartRejected, 'Darts after a checkout must be rejected.');

echo "Dart501Rules OK\n";
