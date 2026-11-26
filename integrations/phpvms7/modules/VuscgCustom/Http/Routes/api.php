<?php

/**
 * This is publicly accessible
 */
Route::group(['middleware' => []], function() {
    Route::get('/', 'ApiController@index');
});

/**
 * This is required to have a valid API key
 */
Route::group(['middleware' => [
    'api.auth'
]], function() {
    Route::get('/hello', 'ApiController@hello');
});

Route::prefix('pirep-review')->middleware('throttle:30,1')->group(function () {
    Route::post('/decision', 'PirepReviewController@decision');
    Route::post('/status', 'PirepReviewController@status');
});
