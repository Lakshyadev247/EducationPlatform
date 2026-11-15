<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('otp_codes', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            // What the code is for. A WhatsApp *integration test* and a real
            // lesson-attendance challenge are deliberately different purposes,
            // so a test code can never satisfy an attendance challenge.
            $table->string('purpose', 40);

            $table->string('channel', 20)->default('whatsapp');
            $table->string('recipient', 32);

            // Only a hash is stored. The plaintext code exists once, in the
            // response that delivers it, and is never persisted or logged.
            $table->string('code_hash');

            $table->unsignedTinyInteger('attempts')->default(0);
            $table->unsignedTinyInteger('max_attempts')->default(5);
            $table->timestamp('expires_at');
            $table->timestamp('consumed_at')->nullable();
            $table->timestamps();

            $table->index(['user_id', 'purpose']);
            $table->index('expires_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('otp_codes');
    }
};
