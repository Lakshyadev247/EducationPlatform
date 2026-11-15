<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use App\Services\WhatsappOtpService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * WhatsApp integration area (Admin Panel).
 *
 * Reports real provider status and exercises the OTP engine. It never claims a
 * message was delivered when no provider is configured.
 */
class WhatsappController extends Controller
{
    public function status(WhatsappOtpService $otp): JsonResponse
    {
        return response()->json(['data' => $otp->providerStatus()]);
    }

    /**
     * Send a test code to the configured test recipient. This is an integration
     * test only — it is issued under a distinct purpose, so it can never be used
     * to satisfy a real lesson-attendance challenge.
     */
    public function testSend(Request $request, WhatsappOtpService $otp, AuditLogger $auditLogger): JsonResponse
    {
        $data = $request->validate([
            'recipient' => ['nullable', 'string', 'max:32'],
        ]);

        $configured = (string) ($this->setting('whatsapp.testRecipient') ?? '');
        $recipient = trim((string) ($data['recipient'] ?? '')) ?: $configured;

        if ($recipient === '') {
            return response()->json([
                'message' => 'No test recipient is configured. Add one with its country code first.',
            ], 422);
        }

        $result = $otp->issue($request->user(), WhatsappOtpService::PURPOSE_TEST, $recipient);

        // The result of the last attempt belongs to the server, so the panel
        // shows what actually happened instead of a value the browser wrote.
        $this->recordTestStatus($result['ok']
            ? ($result['delivered'] ? 'sent' : 'not-delivered')
            : 'failed');

        $auditLogger->record(
            $request->user(),
            'whatsapp.test_send',
            'whatsapp',
            null,
            [],
            [
                'recipient' => $result['ok'] ? preg_replace('/\d(?=\d{2})/', '*', $recipient) : null,
                'delivered' => $result['delivered'],
                'reason' => $result['reason'],
            ],
        );

        if (! $result['ok']) {
            return response()->json(['message' => $result['reason']], 422);
        }

        $payload = [
            'delivered' => $result['delivered'],
            'reason' => $result['reason'],
            'expiresAt' => $result['expiresAt'],
        ];

        // The code is a local integration aid. Returning it from a production
        // deployment would turn the endpoint into a way to mint a valid code
        // for the configured recipient.
        if (! app()->isProduction()) {
            $payload['code'] = $result['code'];
        }

        return response()->json(['data' => $payload], $result['delivered'] ? 200 : 202);
    }

    private function setting(string $key): mixed
    {
        $parts = explode('.', $key);
        $group = app(SettingsService::class)->get($parts[0], []);

        return is_array($group) ? ($group[$parts[1]] ?? null) : null;
    }

    /**
     * Store the outcome of the last test attempt in the settings group the
     * admin panel reads. The value is written by the server, so it always
     * matches what was attempted.
     */
    private function recordTestStatus(string $status): void
    {
        $settings = app(SettingsService::class);
        $group = $settings->get('whatsapp', []);

        if (! is_array($group)) {
            $group = [];
        }

        $group['lastTestStatus'] = $status;
        $settings->putGroups(['whatsapp' => $group], request()->user());
    }
}
