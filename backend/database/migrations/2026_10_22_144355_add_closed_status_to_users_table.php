<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Adds the "closed" state to users.status.
 *
 * A closed account is one that was anonymised by the supported closure
 * workflow. It is also soft deleted, but the explicit status keeps the state
 * readable in the admin directory and in the audit trail, and it makes the
 * login refusal independent of the soft-delete scope.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(
            "ALTER TABLE users MODIFY status ENUM('active', 'suspended', 'closed') "
            ."NOT NULL DEFAULT 'active'"
        );
    }

    public function down(): void
    {
        // A rollback cannot represent "closed". The affected accounts stay
        // blocked (suspended) rather than silently becoming active again.
        DB::statement("UPDATE users SET status = 'suspended' WHERE status = 'closed'");
        DB::statement(
            "ALTER TABLE users MODIFY status ENUM('active', 'suspended') "
            ."NOT NULL DEFAULT 'active'"
        );
    }
};
