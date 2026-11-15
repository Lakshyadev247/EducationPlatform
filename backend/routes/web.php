<?php

use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\PasswordResetController;
use App\Http\Controllers\FrontendController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::get('/', [FrontendController::class, 'index'])->name('frontend.index');

// The page the password reset mail links to. The name is the one Laravel's
// ResetPassword notification uses to build the URL.
Route::get('/reset-password', [FrontendController::class, 'resetPassword'])->name('password.reset');

Route::prefix('api/v1/auth')->name('api.auth.')->group(function (): void {
    Route::get('/csrf', fn (Request $request) => response()->json([
        'token' => csrf_token(),
    ]))->name('csrf');

    Route::post('/register/student', [AuthController::class, 'registerStudent'])
        ->middleware('throttle:5,1')
        ->name('register.student');
    Route::post('/register/teacher', [AuthController::class, 'registerTeacher'])
        ->middleware('throttle:5,1')
        ->name('register.teacher');
    Route::post('/otp/send', [AuthController::class, 'sendRegistrationOtp'])
        ->middleware('throttle:5,1')
        ->name('otp.send');
    Route::post('/password/otp/request', [PasswordResetController::class, 'otpRequest'])
        ->middleware('throttle:password-reset-request')
        ->name('password.otp.request');
    Route::post('/password/otp/verify', [PasswordResetController::class, 'otpVerify'])
        ->middleware('throttle:password-reset-submit')
        ->name('password.otp.verify');
    Route::post('/password/otp/reset', [PasswordResetController::class, 'otpReset'])
        ->middleware('throttle:password-reset-submit')
        ->name('password.otp.reset');
    Route::post('/login', [AuthController::class, 'login'])
        ->middleware('throttle:5,1')
        ->name('login');
    Route::post('/password/forgot', [PasswordResetController::class, 'request'])
        ->middleware('throttle:password-reset-request')
        ->name('password.forgot');
    Route::post('/password/reset', [PasswordResetController::class, 'reset'])
        ->middleware('throttle:password-reset-submit')
        ->name('password.reset.submit');
    Route::post('/logout', [AuthController::class, 'logout'])
        ->name('logout');
});
Route::get('/index.html', [FrontendController::class, 'index'])->name('frontend.index.html');
Route::get('/assets/{path}', [FrontendController::class, 'asset'])
    ->where('path', '.*')
    ->name('frontend.asset');

if (app()->environment(['local', 'testing'])) {
    Route::get('/tests/{path}', [FrontendController::class, 'testAsset'])
        ->where('path', '.*')
        ->name('frontend.test-asset');
}
