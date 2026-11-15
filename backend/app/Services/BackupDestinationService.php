<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use InvalidArgumentException;

/**
 * Resolves and validates the folders the application may write backups into.
 *
 * A browser cannot give the server permission to write to an arbitrary
 * folder, so only folders below an explicitly configured backup root are
 * reachable. Every path is resolved to its canonical form and compared with
 * the root it came from, which rejects "..", symbolic links that leave the
 * root, and folders that were never authorised in the first place.
 */
class BackupDestinationService
{
    public const INTERNAL_ROOT = 'internal';

    /**
     * System folders that must never receive a database dump.
     *
     * @var list<string>
     */
    private const SYSTEM_DIRECTORIES = [
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/boot',
        '/dev',
        '/proc',
        '/sys',
        '/lib',
        '/lib64',
        '/var/run',
        '/var/lib',
        '/srv',
    ];

    /**
     * The Windows equivalents of the system folders above.
     *
     * @var list<string>
     */
    private const WINDOWS_SYSTEM_DIRECTORIES = [
        'C:/Windows',
        'C:/Program Files',
        'C:/Program Files (x86)',
        'C:/ProgramData',
        'C:/$Recycle.Bin',
        'C:/System Volume Information',
    ];

    /**
     * The backup locations the Super Admin may choose from.
     *
     * @return list<array{id: string, label: string, path: string, writable: bool}>
     */
    public function roots(): array
    {
        $roots = [[
            'id' => self::INTERNAL_ROOT,
            'label' => 'Application backup area',
            'path' => $this->internalRootPath(),
            'writable' => $this->isWritableDirectory($this->internalRootPath()),
        ]];

        foreach ($this->configuredRoots() as $index => $path) {
            $roots[] = [
                'id' => 'root-'.($index + 1),
                'label' => 'Configured backup root '.($index + 1),
                'path' => $path,
                'writable' => $this->isWritableDirectory($path),
            ];
        }

        return $roots;
    }

    public function hasRoot(string $id): bool
    {
        foreach ($this->roots() as $root) {
            if ($root['id'] === $id) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return array{id: string, label: string, path: string, writable: bool}
     */
    public function root(string $id): array
    {
        foreach ($this->roots() as $root) {
            if ($root['id'] === $id) {
                return $root;
            }
        }

        throw new InvalidArgumentException('That backup location is not configured on this server.');
    }

    /**
     * Resolve a folder inside a backup root to an absolute path.
     *
     * The path is canonical: it cannot leave the root, cannot cross a
     * symbolic link and cannot point at a folder that must never hold a
     * database dump.
     */
    public function resolve(string $rootId, string $relative): string
    {
        $root = $this->root($rootId);

        if ($root['id'] === self::INTERNAL_ROOT && ! is_dir($root['path'])) {
            // The application's own backup area is created on demand.
            File::ensureDirectoryExists($root['path']);
        }

        $rootReal = realpath($root['path']);

        if ($rootReal === false || ! is_dir($rootReal)) {
            throw new InvalidArgumentException(sprintf(
                'The backup location "%s" does not exist on this server.',
                (string) $root['label']
            ));
        }

        if ($this->isForbidden($rootReal)) {
            throw new InvalidArgumentException('The backup location "'.$root['label'].'" is not allowed for database dumps.');
        }

        $current = $rootReal;

        foreach ($this->segments($relative) as $segment) {
            $current .= DIRECTORY_SEPARATOR.$segment;

            if (is_link($current)) {
                throw new InvalidArgumentException('Symbolic links are not allowed inside a backup location.');
            }
        }

        // The longest existing part of the path must still be inside the root.
        $probe = $current;

        while ($probe !== $rootReal && ! file_exists($probe)) {
            $probe = dirname($probe);
        }

        $probeReal = realpath($probe);

        if ($probeReal === false || ($probeReal !== $rootReal && ! str_starts_with($probeReal, $rootReal.DIRECTORY_SEPARATOR))) {
            throw new InvalidArgumentException('That folder is outside the authorised backup location.');
        }

        if ($this->isForbidden($current)) {
            throw new InvalidArgumentException('A database dump may not be written to that folder.');
        }

        return $current;
    }

    /**
     * List the folders inside a backup root.
     *
     * @return array{
     *     root: array{id: string, label: string, path: string, writable: bool},
     *     path: string,
     *     absolute: string,
     *     parent: string|null,
     *     directories: list<array{name: string, path: string, absolute: string, writable: bool}>
     * }
     */
    public function browse(string $rootId, string $relative): array
    {
        $root = $this->root($rootId);
        $absolute = $this->resolve($rootId, $relative);

        if (! is_dir($absolute)) {
            throw new InvalidArgumentException('That folder does not exist on the server.');
        }

        $rootReal = (string) realpath($root['path']);
        $directories = [];

        foreach (File::directories($absolute) as $child) {
            if (is_link($child)) {
                continue;
            }

            $name = basename($child);

            if (str_starts_with($name, '.')) {
                continue;
            }

            $childReal = realpath($child);

            if ($childReal === false || ! str_starts_with($childReal, $rootReal.DIRECTORY_SEPARATOR)) {
                continue;
            }

            if ($this->isForbidden($childReal)) {
                continue;
            }

            $directories[] = [
                'name' => $name,
                'path' => $this->join($relative, $name),
                'absolute' => $childReal,
                'writable' => $this->isWritableDirectory($childReal),
            ];
        }

        usort($directories, static fn (array $a, array $b): int => strnatcasecmp($a['name'], $b['name']));

        return [
            'root' => $root,
            'path' => trim(str_replace('\\', '/', $relative), '/'),
            'absolute' => $absolute,
            'parent' => $this->parentPath($relative),
            'directories' => $directories,
        ];
    }

    /**
     * Create a folder inside a backup root.
     *
     * @return array{name: string, path: string, absolute: string, writable: bool}
     */
    public function createDirectory(string $rootId, string $relative, string $name): array
    {
        $name = trim($name);

        if (preg_match('/^[A-Za-z0-9._\-]{1,60}$/', $name) !== 1 || $name === '.' || $name === '..') {
            throw new InvalidArgumentException('Use 1-60 letters, numbers, dots, dashes or underscores for the folder name.');
        }

        $parent = $this->resolve($rootId, $relative);

        if (! is_dir($parent)) {
            throw new InvalidArgumentException('The parent folder does not exist on the server.');
        }

        $target = $parent.DIRECTORY_SEPARATOR.$name;

        if (file_exists($target)) {
            throw new InvalidArgumentException('A folder with that name already exists.');
        }

        if (! @mkdir($target, 0755)) {
            throw new InvalidArgumentException('The folder could not be created. Check the permissions of the parent folder.');
        }

        return [
            'name' => $name,
            'path' => $this->join($relative, $name),
            'absolute' => realpath($target) ?: $target,
            'writable' => $this->isWritableDirectory($target),
        ];
    }

    /**
     * True when a folder must never hold a database dump.
     */
    public function isForbidden(string $absolute): bool
    {
        $path = $this->normalise($absolute);

        if (str_starts_with($path, '//')) {
            // A network share is not an authorised backup location.
            return true;
        }

        if ($this->isInside($path, $this->normalise(public_path()))
            || $this->isInside($path, $this->normalise(storage_path('app/public')))) {
            // Uploads are served by the web server; a dump must never be.
            return true;
        }

        if ($this->isInside($path, $this->normalise(base_path()))
            && ! $this->isInside($path, $this->normalise(storage_path('app')))) {
            // Application source, configuration and .env files.
            return true;
        }

        $systemFolders = self::SYSTEM_DIRECTORIES;

        if (PHP_OS_FAMILY === 'Windows') {
            $systemFolders = array_merge($systemFolders, self::WINDOWS_SYSTEM_DIRECTORIES);
        }

        foreach ($systemFolders as $folder) {
            if ($this->isInside($path, $this->normalise($folder))) {
                return true;
            }
        }

        return false;
    }

    public function isWritableDirectory(string $path): bool
    {
        return is_dir($path) && is_writable($path);
    }

    /**
     * The backup area inside the application, or the folder the server owner
     * moved it to with BACKUP_BASE.
     */
    public function internalRootPath(): string
    {
        $base = trim((string) config('backup.base', ''));

        if ($base === '') {
            $base = storage_path('app');
        }

        return rtrim($base, '/\\').DIRECTORY_SEPARATOR.'backups';
    }

    /**
     * @return list<string>
     */
    private function configuredRoots(): array
    {
        $configured = config('backup.roots', []);

        if (! is_array($configured)) {
            return [];
        }

        $roots = [];

        foreach ($configured as $path) {
            $path = trim((string) $path);

            if ($path === '' || ! $this->isAbsolute($path)) {
                continue;
            }

            $roots[] = rtrim($path, '/\\');
        }

        return $roots;
    }

    /**
     * @return list<string>
     */
    private function segments(string $relative): array
    {
        if (str_starts_with($relative, '/')
            || str_starts_with($relative, '\\')
            || preg_match('/^[A-Za-z]:/', $relative) === 1) {
            throw new InvalidArgumentException('An absolute path is not a valid folder inside a backup location.');
        }

        $relative = trim(str_replace('\\', '/', $relative), '/');

        if ($relative === '') {
            return [];
        }

        $segments = [];

        foreach (explode('/', $relative) as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') {
                throw new InvalidArgumentException('That folder path is not valid.');
            }

            if (preg_match('/^[A-Za-z0-9._\-]+$/', $segment) !== 1) {
                throw new InvalidArgumentException('Folder names may only contain letters, numbers, dots, dashes and underscores.');
            }

            $segments[] = $segment;
        }

        return $segments;
    }

    private function join(string $relative, string $name): string
    {
        $relative = trim(str_replace('\\', '/', $relative), '/');

        return $relative === '' ? $name : $relative.'/'.$name;
    }

    private function parentPath(string $relative): ?string
    {
        $relative = trim(str_replace('\\', '/', $relative), '/');

        if ($relative === '' || ! str_contains($relative, '/')) {
            return null;
        }

        return dirname($relative);
    }

    private function isAbsolute(string $path): bool
    {
        return str_starts_with($path, '/')
            || preg_match('/^[A-Za-z]:[\\\\\/]/', $path) === 1
            || str_starts_with($path, '\\\\');
    }

    private function normalise(string $path): string
    {
        $path = rtrim(str_replace('\\', '/', $path), '/');

        if ($path === '') {
            return $path;
        }

        return PHP_OS_FAMILY === 'Windows' ? strtolower($path) : $path;
    }

    private function isInside(string $path, string $parent): bool
    {
        if ($parent === '') {
            return false;
        }

        return $path === $parent || str_starts_with($path, $parent.'/');
    }
}
