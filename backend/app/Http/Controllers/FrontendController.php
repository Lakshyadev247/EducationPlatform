<?php

namespace App\Http\Controllers;

use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

class FrontendController extends Controller
{
    public function index(): BinaryFileResponse
    {
        abort_unless(is_file(base_path('../index.html')), 404);

        return response()->file(base_path('../index.html'), [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    /**
     * The standalone page that the password reset mail links to. It is kept
     * outside the single page app so a reset never depends on the app's
     * client-side router.
     */
    public function resetPassword(): BinaryFileResponse
    {
        abort_unless(is_file(base_path('../reset-password.html')), 404);

        return response()->file(base_path('../reset-password.html'), [
            'Content-Type' => 'text/html; charset=UTF-8',
        ]);
    }

    public function asset(string $path): BinaryFileResponse
    {
        return $this->fileFrom(base_path('../assets'), $path);
    }

    public function testAsset(string $path): BinaryFileResponse
    {
        abort_unless(app()->environment(['local', 'testing']), 404);

        return $this->fileFrom(base_path('../tests'), $path);
    }

    private function fileFrom(string $basePath, string $relativePath): BinaryFileResponse
    {
        $base = realpath($basePath);
        $candidate = realpath($basePath.DIRECTORY_SEPARATOR.$relativePath);

        abort_if($base === false || $candidate === false, 404);
        abort_unless(
            is_file($candidate) && Str::startsWith($candidate, $base.DIRECTORY_SEPARATOR),
            404
        );

        return response()->file($candidate, [
            'Content-Type' => $this->contentType($candidate),
            // The assets are served straight from disk, without a build step,
            // so the browser has to check them before it uses them. A cached
            // copy of an older app.js made the panel run code that was no
            // longer on the server.
            'Cache-Control' => 'no-cache',
        ]);
    }

    private function contentType(string $path): string
    {
        return match (Str::lower(pathinfo($path, PATHINFO_EXTENSION))) {
            'css' => 'text/css; charset=UTF-8',
            'js', 'mjs' => 'text/javascript; charset=UTF-8',
            'html' => 'text/html; charset=UTF-8',
            'json', 'map' => 'application/json; charset=UTF-8',
            'svg' => 'image/svg+xml',
            'png' => 'image/png',
            'jpg', 'jpeg' => 'image/jpeg',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'ico' => 'image/x-icon',
            'woff' => 'font/woff',
            'woff2' => 'font/woff2',
            'ttf' => 'font/ttf',
            default => 'application/octet-stream',
        };
    }
}
