<?php

namespace App\Http\Controllers\Api\V1\Admin;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\AccountClosureService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The supported way to close an account.
 *
 * This is deliberately an administrative action. Closing is irreversible from
 * the product's point of view, so it requires an administrator, protects the
 * actor's own account, and reserves administrative targets for a Super Admin.
 * The service decides the policy; the controller only validates the input.
 */
class AccountClosureController extends Controller
{
    public function destroy(
        Request $request,
        User $user,
        AccountClosureService $closure,
    ): JsonResponse {
        $data = $request->validate([
            'reason' => ['nullable', 'string', 'max:400'],
        ]);

        $result = $closure->close($request->user(), $user, $data['reason'] ?? null);

        return response()->json([
            'data' => [
                'id' => $user->id,
                'status' => $user->status,
                'closed' => true,
                'already_closed' => $result['already_closed'],
            ],
            'meta' => [
                'revoked_sessions' => $result['sessions'],
                'revoked_tokens' => $result['tokens'],
            ],
        ]);
    }
}
