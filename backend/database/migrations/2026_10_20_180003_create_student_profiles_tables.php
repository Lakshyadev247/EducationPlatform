<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_profiles', function (Blueprint $table) {
            $table->foreignId('user_id')->primary()->constrained()->cascadeOnDelete();
            $table->foreignId('education_level_id')->nullable()->constrained()->restrictOnDelete();
            $table->string('level_other', 80)->nullable();
            $table->string('intro', 300)->nullable();
            $table->string('photo_path', 255)->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->timestamps();
            $table->index('education_level_id');
        });

        Schema::create('student_addresses', function (Blueprint $table) {
            $table->foreignId('user_id')->primary()->constrained()->cascadeOnDelete();
            $table->text('address_line_1')->nullable();
            $table->text('address_line_2')->nullable();
            $table->text('area')->nullable();
            $table->text('city')->nullable();
            $table->text('state')->nullable();
            $table->text('postal_code')->nullable();
            $table->string('country', 80)->nullable();
            $table->decimal('latitude', 10, 7)->nullable();
            $table->decimal('longitude', 10, 7)->nullable();
            $table->boolean('is_primary')->default(true);
            $table->timestamps();
        });

        DB::statement(
            'ALTER TABLE student_addresses ADD CONSTRAINT student_addresses_latitude_check '
            .'CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90))'
        );
        DB::statement(
            'ALTER TABLE student_addresses ADD CONSTRAINT student_addresses_longitude_check '
            .'CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))'
        );
    }

    public function down(): void
    {
        Schema::dropIfExists('student_addresses');
        Schema::dropIfExists('student_profiles');
    }
};
