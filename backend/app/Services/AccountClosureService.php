<?php

namespace App\Services;

use App\Models\Role;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Closes an account by anonymising it and soft deleting it.
 *
 * Physical deletion is not an option here: bookings, attendance records,
 * reviews, terms acceptances and audit entries point at the account and are
 * declared RESTRICT on delete, because they are operational, legal or
 * financial history that must survive the account. Closing therefore:
 *
 *  - replaces the personal fields (name, email, phone, password) with neutral
 *    values and marks the row "closed";
 *  - soft deletes the row, so the history keeps a valid owner and the account
 *    can never sign in again;
 *  - removes the direct contact data that has no historical value (the private
 *    student address and the public teacher locations) and clears the profile
 *    text and photos;
 *  - revokes the sessions and API tokens of the account;
 *  - writes one audit event that identifies the account by id and a masked
 *    email, never by the password or a token.
 *
 * The history itself (bookings, attendance, reviews, terms acceptances,
 * notifications, audit trail) is retained. Repeated requests are safe: an
 * account that is already closed is reported as such and nothing is changed.
 */
class AccountClosureService
{
    public function __construct(
        private readonly AccountSessionService $sessions,
        private readonly AuditLogger $auditLogger,
    ) {}

    /**
     * @return array{already_closed: bool, sessions: int, tokens: int}
     */
    public function close(User $actor, User $user, ?string $reason = null): array
    {
        $this->assertMayClose($actor, $user);

        if ($user->trashed() || $user->status === 'closed') {
            return ['already_closed' => true, 'sessions' => 0, 'tokens' => 0];
        }

        $oldStatus = $user->status;
        $maskedEmail = $this->maskEmail((string) $user->email);
        $revoked = ['sessions' => 0, 'tokens' => 0];

        DB::transaction(function () use ($actor, $user, $reason, $oldStatus, $maskedEmail, &$revoked): void {
            $user->forceFill([
                'name' => 'Closed account',
                'email' => 'closed+'.$user->id.'@closed.invalid',
                'phone' => null,
                'password' => Hash::make(Str::random(64)),
                'remember_token' => null,
                'email_verified_at' => null,
                'status' => 'closed',
            ])->save();

            $this->removePersonalProfileData($user);

            $revoked = $this->sessions->revoke($user);

            $user->delete();

            $this->auditLogger->record(
                $actor,
                'user.account_closed',
                User::class,
                $user->id,
                ['status' => $oldStatus, 'email' => $maskedEmail],
                ['status' => 'closed'],
                $reason,
            );
        });

        return ['already_closed' => false] + $revoked;
    }

    private function assertMayClose(User $actor, User $user): void
    {
        if (! $actor->isAdmin()) {
            abort(403, 'You do not have permission to close an account.');
        }

        if ($actor->id === $user->id) {
            abort(422, 'You cannot close your own account.');
        }

        if ($user->isAdmin() && ! $actor->isSuperAdmin()) {
            abort(403, 'Only a Super Admin can close an administrative account.');
        }

        if ($user->trashed() || $user->status === 'closed') {
            return;
        }

        if ($user->isSuperAdmin() && $this->remainingActiveSuperAdmins($user) < 1) {
            abort(422, 'The last Super Admin cannot be closed.');
        }
    }

    private function remainingActiveSuperAdmins(User $target): int
    {
        return User::query()
            ->whereKeyNot($target->getKey())
            ->where('status', 'active')
            ->whereHas('roles', fn ($query) => $query->where('name', Role::SUPER_ADMIN))
            ->count();
    }

    /**
     * Remove the personal fields that have no historical value.
     *
     * The rows themselves stay: bookings, availability and prices point at the
     * teacher profile, and removing it would break them.
     */
    private function removePersonalProfileData(User $user): void
    {
        $teacher = $user->teacherProfile;

        if ($teacher !== null) {
            $teacher->forceFill([
                'bio' => null,
                'photo_path' => null,
                'experience_level' => null,
                'experience_years' => null,
                'experience_org' => null,
                'experience_description' => null,
                'teaching_mode' => null,
                'online_tools' => null,
                'is_public' => false,
            ])->save();

            // The service locations are exact addresses, not history.
            $teacher->serviceLocations()->delete();
        }

        $student = $user->studentProfile;

        if ($student !== null) {
            $student->forceFill([
                'intro' => null,
                'photo_path' => null,
                'level_other' => null,
            ])->save();
        }

        // The private address is contact data with no operational value.
        $user->studentAddress()->delete();
    }

    private function maskEmail(string $email): string
    {
        [$local, $domain] = array_pad(explode('@', $email, 2), 2, '');

        if ($local === '' || $domain === '') {
            return '[redacted]';
        }

        return mb_substr($local, 0, 1).'***@'.$domain;
    }
}
