<?php

namespace App\Services;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Ends the authenticated sessions of one account.
 *
 * Changing an account's status used to leave every session it had open. A
 * suspended user could keep using the account until the session expired, and
 * a closed account could keep its session too. The sessions and the API tokens
 * of that one account are removed here, and nothing else is touched.
 */
class AccountSessionService
{
    /**
     * Revoke every session and API token of one account.
     *
     * Only the rows that belong to the given account are removed. Sessions of
     * other accounts, and the session rows of anonymous visitors, are left
     * exactly as they are.
     *
     * @return array{sessions: int, tokens: int}
     */
    public function revoke(User $user): array
    {
        $sessions = 0;
        $tokens = 0;

        if (config('session.driver') === 'database') {
            $table = (string) config('session.table', 'sessions');

            if (Schema::hasTable($table)) {
                $sessions = DB::table($table)->where('user_id', $user->id)->delete();
            }
        }

        if (Schema::hasTable('personal_access_tokens')) {
            $tokens = DB::table('personal_access_tokens')
                ->where('tokenable_type', User::class)
                ->where('tokenable_id', $user->id)
                ->delete();
        }

        return ['sessions' => $sessions, 'tokens' => $tokens];
    }
}
