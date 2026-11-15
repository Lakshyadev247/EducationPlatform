<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class StorageLog extends Model
{
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'provider_key',
        'action',
        'status',
        'document_id',
        'file_name',
        'file_size',
        'duration_ms',
        'message',
        'user_id',
        'ip_address',
        'created_at',
    ];

    protected $casts = [
        'file_size' => 'integer',
        'duration_ms' => 'integer',
        'created_at' => 'datetime',
    ];

    public function document(): BelongsTo
    {
        return $this->belongsTo(StorageDocument::class, 'document_id');
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function provider(): BelongsTo
    {
        return $this->belongsTo(StorageProvider::class, 'provider_key', 'provider_key');
    }
}
