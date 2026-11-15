<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Operational health.
 *
 * The public endpoint answers one question - is the service able to serve? -
 * with one field. It used to report the service name, the database state and a
 * timestamp, which tells a stranger about the infrastructure without helping
 * the load balancer that only needs the status code. The detailed view is
 * available to an authenticated administrator.
 */
class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $healthy = $this->databaseIsReachable();

        return response()->json(
            ['status' => $healthy ? 'ok' : 'degraded'],
            $healthy ? 200 : 503
        );
    }

    public function detailed(): JsonResponse
    {
        $database = $this->databaseIsReachable() ? 'ok' : 'unavailable';

        return response()->json([
            'data' => [
                'status' => $database === 'ok' ? 'ok' : 'degraded',
                'service' => 'api',
                'database' => $database,
                'timestamp' => now()->toIso8601String(),
            ],
        ], $database === 'ok' ? 200 : 503);
    }

    private function databaseIsReachable(): bool
    {
        try {
            DB::select('select 1');

            return true;
        } catch (Throwable) {
            return false;
        }
    }
}
