<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class StudentAddress extends Model
{
    protected $primaryKey = 'user_id';

    public $incrementing = false;

    protected $keyType = 'int';

    /**
     * @var list<string>
     */
    protected $fillable = [
        'user_id',
        'address_line_1',
        'address_line_2',
        'area',
        'city',
        'state',
        'postal_code',
        'country',
        'latitude',
        'longitude',
        'is_primary',
    ];

    /**
     * @var list<string>
     */
    protected $hidden = [
        'address_line_1',
        'address_line_2',
        'area',
        'city',
        'state',
        'postal_code',
        'latitude',
        'longitude',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'address_line_1' => 'encrypted',
            'address_line_2' => 'encrypted',
            'area' => 'encrypted',
            'city' => 'encrypted',
            'state' => 'encrypted',
            'postal_code' => 'encrypted',
            'is_primary' => 'boolean',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
