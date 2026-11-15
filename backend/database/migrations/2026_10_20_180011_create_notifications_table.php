<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('notifications', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('category', 40);
            $table->string('title', 160);
            $table->text('message');
            $table->timestamp('read_at')->nullable();
            $table->string('ref_type', 40)->nullable();
            $table->string('ref_id', 64)->nullable();
            $table->string('dedupe_key', 191)->nullable();
            $table->timestamps();
            $table->index(['user_id', 'read_at']);
            $table->index('category');
            $table->unique(['user_id', 'dedupe_key'], 'notifications_user_dedupe_unique');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('notifications');
    }
};
