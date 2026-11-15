<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class StorageDocument extends Model
{
    use HasFactory;

    protected $fillable = [
        'uuid',
        'user_id',
        'provider_key',
        'collection',
        'original_name',
        'file_path',
        'mime_type',
        'file_size',
        'checksum',
        'metadata',
        'created_by',
    ];

    protected $casts = [
        'file_size' => 'integer',
        'metadata' => 'array',
    ];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function provider(): BelongsTo
    {
        return $this->belongsTo(StorageProvider::class, 'provider_key', 'provider_key');
    }

    public function logs(): HasMany
    {
        return $this->hasMany(StorageLog::class, 'document_id');
    }

    public function getFormattedSizeAttribute(): string
    {
        $bytes = (int) $this->file_size;
        if ($bytes < 1024) return $bytes . ' B';
        if ($bytes < 1048576) return round($bytes / 1024, 1) . ' KB';
        if ($bytes < 1073741824) return round($bytes / 1048576, 2) . ' MB';
        return round($bytes / 1073741824, 2) . ' GB';
    }
}
