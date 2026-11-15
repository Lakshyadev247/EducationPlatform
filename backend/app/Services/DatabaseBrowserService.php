<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * A read-only view of the configured database for the Super Admin panel.
 *
 * Only tables that exist in the current schema are reachable; identifiers are
 * quoted and every value passes through the sensitive-column mask before it
 * leaves the server. There is no insert, update or delete path here.
 */
class DatabaseBrowserService
{
    private const MAX_PER_PAGE = 100;

    private const MAX_VALUE_LENGTH = 400;

    private const SENSITIVE_PARTS = [
        'password',
        'passwd',
        'remember_token',
        'token',
        'secret',
        'api_key',
        'apikey',
        'access_key',
        'private_key',
        'payload',
    ];

    /**
     * @var list<string>|null
     */
    private ?array $cachedTableNames = null;

    /**
     * @return list<string>
     */
    public function tableNames(): array
    {
        if ($this->cachedTableNames === null) {
            $this->cachedTableNames = array_values(array_map(
                static fn (object $row): string => (string) $row->name,
                DB::select(
                    "select table_name as name from information_schema.tables
                     where table_schema = database() and table_type = 'BASE TABLE'
                     order by table_name"
                )
            ));
        }

        return $this->cachedTableNames;
    }

    /**
     * @return array{driver: string, host: ?string, port: ?int, database: string, version: ?string, size_bytes: int, table_count: int}
     */
    public function connection(): array
    {
        $connection = DB::connection();
        $config = (array) config('database.connections.'.$connection->getName(), []);
        $driver = (string) $connection->getDriverName();
        $version = null;
        $sizeBytes = 0;

        if ($driver === 'mysql') {
            $versionRow = DB::selectOne('select version() as version');
            $version = $versionRow?->version !== null ? (string) $versionRow->version : null;

            $sizeRow = DB::selectOne(
                'select coalesce(sum(data_length + index_length), 0) as bytes
                 from information_schema.tables where table_schema = database()'
            );
            $sizeBytes = (int) ($sizeRow?->bytes ?? 0);
        }

        return [
            'driver' => $driver,
            'host' => isset($config['host']) ? (string) $config['host'] : null,
            'port' => isset($config['port']) ? (int) $config['port'] : null,
            'database' => (string) $connection->getDatabaseName(),
            'version' => $version,
            'size_bytes' => $sizeBytes,
            'table_count' => count($this->tableNames()),
        ];
    }

    /**
     * @return list<array{name: string, rows: int, size_bytes: int}>
     */
    public function tables(): array
    {
        $tables = [];

        foreach ($this->tableNames() as $table) {
            $count = DB::selectOne('select count(*) as aggregate from '.$this->quoteIdentifier($table));
            $size = DB::selectOne(
                'select coalesce(data_length, 0) + coalesce(index_length, 0) as bytes
                 from information_schema.tables where table_schema = database() and table_name = ?',
                [$table]
            );

            $tables[] = [
                'name' => $table,
                'rows' => (int) ($count?->aggregate ?? 0),
                'size_bytes' => (int) ($size?->bytes ?? 0),
            ];
        }

        return $tables;
    }

    /**
     * @return list<array{name: string, type: string, nullable: bool, key: ?string, sensitive: bool}>
     */
    public function columns(string $table): array
    {
        $this->assertTable($table);

        $rows = DB::select(
            'select column_name as name, data_type as type, is_nullable as nullable, column_key as key_name
             from information_schema.columns
             where table_schema = database() and table_name = ?
             order by ordinal_position',
            [$table]
        );

        return array_map(function (object $row): array {
            return [
                'name' => (string) $row->name,
                'type' => (string) $row->type,
                'nullable' => $row->nullable === 'YES',
                'key' => $row->key_name !== null && $row->key_name !== '' ? (string) $row->key_name : null,
                'sensitive' => $this->isSensitive((string) $row->name),
            ];
        }, $rows);
    }

    /**
     * @return array{
     *     table: string,
     *     columns: list<array{name: string, type: string, nullable: bool, key: ?string, sensitive: bool}>,
     *     rows: list<array<string, mixed>>,
     *     meta: array{total: int, page: int, per_page: int, last_page: int}
     * }
     */
    public function rows(string $table, int $page, int $perPage, string $search = ''): array
    {
        $this->assertTable($table);

        $columns = $this->columns($table);
        $perPage = max(1, min(self::MAX_PER_PAGE, $perPage));
        $quotedTable = $this->quoteIdentifier($table);

        $where = '';
        $bindings = [];
        $search = trim($search);

        if ($search !== '') {
            // Masked columns are not searchable: the browser must not become a
            // way to probe a password hash or a token by substring.
            $visibleNames = array_values(array_map(
                static fn (array $column): string => $column['name'],
                array_filter($columns, static fn (array $column): bool => ! $column['sensitive'])
            ));

            if ($visibleNames !== []) {
                $searchable = array_map(
                    fn (string $name): string => 'coalesce(cast('.$this->quoteIdentifier($name).' as char), \'\')',
                    $visibleNames
                );
                $where = " where concat_ws(' ', ".implode(', ', $searchable).') like ?';
                $bindings[] = '%'.addcslashes($search, '%_\\').'%';
            }
        }

        $total = (int) (DB::selectOne('select count(*) as aggregate from '.$quotedTable.$where, $bindings)?->aggregate ?? 0);
        $lastPage = max(1, (int) ceil($total / $perPage));
        $page = max(1, min($lastPage, $page));
        $offset = ($page - 1) * $perPage;

        $select = 'select * from '.$quotedTable.$where;
        $order = $this->orderColumn($columns);

        if ($order !== null) {
            $select .= ' order by '.$this->quoteIdentifier($order).' asc';
        }

        $select .= ' limit '.$perPage.' offset '.$offset;

        $rows = array_map(function (object $row) use ($columns): array {
            $output = [];

            foreach ($columns as $column) {
                $value = $row->{$column['name']} ?? null;

                if ($value !== null && $column['sensitive']) {
                    $output[$column['name']] = '••••••';
                } elseif ($value === null) {
                    $output[$column['name']] = null;
                } else {
                    $output[$column['name']] = Str::limit((string) $value, self::MAX_VALUE_LENGTH, '…');
                }
            }

            return $output;
        }, DB::select($select, $bindings));

        return [
            'table' => $table,
            'columns' => $columns,
            'rows' => $rows,
            'meta' => [
                'total' => $total,
                'page' => $page,
                'per_page' => $perPage,
                'last_page' => $lastPage,
            ],
        ];
    }

    private function assertTable(string $table): void
    {
        if (! in_array($table, $this->tableNames(), true)) {
            abort(404);
        }
    }

    /**
     * @param  list<array{name: string, type: string, nullable: bool, key: ?string, sensitive: bool}>  $columns
     */
    private function orderColumn(array $columns): ?string
    {
        foreach ($columns as $column) {
            if ($column['key'] === 'PRI') {
                return $column['name'];
            }
        }

        return $columns[0]['name'] ?? null;
    }

    private function isSensitive(string $column): bool
    {
        $column = strtolower($column);

        // Short tokens such as "pin" and "otp" are common inside ordinary
        // words (for example "shipping"), so they only count as a whole
        // underscore-delimited segment.
        if (preg_match('/(^|_)(pin|otp)($|_)/', $column) === 1) {
            return true;
        }

        foreach (self::SENSITIVE_PARTS as $part) {
            if (str_contains($column, $part)) {
                return true;
            }
        }

        return false;
    }

    private function quoteIdentifier(string $identifier): string
    {
        return '`'.str_replace('`', '``', $identifier).'`';
    }
}
