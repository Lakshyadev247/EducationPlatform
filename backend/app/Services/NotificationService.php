<?php

namespace App\Services;

use App\Models\Notification;
use App\Models\Role;
use App\Models\User;

class NotificationService
{
    public function __construct(private readonly SettingsService $settings) {}

    public function send(
        User|int $recipient,
        string $category,
        string $title,
        string $message,
        ?string $refType = null,
        string|int|null $refId = null,
        ?string $dedupeKey = null,
    ): ?Notification {
        if (! $this->settings->notificationEnabled($category)) {
            return null;
        }

        $recipientId = $recipient instanceof User ? $recipient->id : $recipient;

        if ($dedupeKey !== null) {
            $existing = Notification::query()
                ->where('user_id', $recipientId)
                ->where('dedupe_key', $dedupeKey)
                ->first();

            if ($existing !== null) {
                return $existing;
            }
        }

        return Notification::query()->create([
            'user_id' => $recipientId,
            'category' => $category,
            'title' => $title,
            'message' => $message,
            'ref_type' => $refType,
            'ref_id' => $refId === null ? null : (string) $refId,
            'dedupe_key' => $dedupeKey,
        ]);
    }

    /**
     * @param  array<string, mixed>  $options
     */
    public function sendToAdmins(
        string $category,
        string $title,
        string $message,
        ?string $refType = null,
        string|int|null $refId = null,
        ?string $dedupePrefix = null,
    ): void {
        $admins = User::query()
            ->where('status', 'active')
            ->whereHas('roles', fn ($query) => $query->whereIn('name', [Role::ADMIN, Role::SUPER_ADMIN]))
            ->get();

        foreach ($admins as $admin) {
            $dedupe = $dedupePrefix === null ? null : $dedupePrefix.':'.$admin->id;
            $this->send($admin, $category, $title, $message, $refType, $refId, $dedupe);
        }
    }
}
