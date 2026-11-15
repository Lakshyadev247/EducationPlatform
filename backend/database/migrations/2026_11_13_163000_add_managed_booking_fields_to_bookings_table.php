<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bookings', function (Blueprint $table) {
            $table->string('booking_type', 20)->default('demo')->after('teaching_mode');
            $table->decimal('agreed_price', 10, 2)->nullable()->after('status');
            $table->string('pricing_type', 20)->nullable()->after('agreed_price');
            $table->text('admin_notes')->nullable()->after('rejection_reason');
            $table->foreignId('approved_by')->nullable()->after('cancelled_by')->constrained('users')->nullOnDelete();
            $table->timestamp('approved_at')->nullable()->after('decided_at');
        });
    }

    public function down(): void
    {
        Schema::table('bookings', function (Blueprint $table) {
            $table->dropForeign(['approved_by']);
            $table->dropColumn([
                'booking_type',
                'agreed_price',
                'pricing_type',
                'admin_notes',
                'approved_by',
                'approved_at',
            ]);
        });
    }
};
