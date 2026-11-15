<?php

namespace App\Services\Storage;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\ClientException;
use League\Flysystem\Config;
use League\Flysystem\FileAttributes;
use League\Flysystem\FilesystemAdapter;
use League\Flysystem\UnableToCheckExistence;
use League\Flysystem\UnableToDeleteFile;
use League\Flysystem\UnableToReadFile;
use League\Flysystem\UnableToWriteFile;

class AzureBlobFilesystemAdapter implements FilesystemAdapter
{
    private Client $client;
    private string $baseUrl;

    public function __construct(
        private readonly string $accountName,
        private readonly string $accountKey,
        private readonly string $container,
        ?string $customEndpoint = null
    ) {
        $this->client = new Client(['timeout' => 30]);
        $endpoint = rtrim($customEndpoint ?: "https://{$this->accountName}.blob.core.windows.net", '/');
        $this->baseUrl = "{$endpoint}/" . ltrim($this->container, '/');
    }

    private function getHeaders(string $method, string $path, array $extraHeaders = [], string $contentLength = '', string $contentType = ''): array
    {
        $date = gmdate('D, d M Y H:i:s \G\M\T');
        $headers = array_merge([
            'x-ms-date' => $date,
            'x-ms-version' => '2020-10-02',
        ], $extraHeaders);

        // Canonicalized headers
        $canonicalizedHeaders = '';
        $msHeaders = [];
        foreach ($headers as $k => $v) {
            $lower = strtolower($k);
            if (str_starts_with($lower, 'x-ms-')) {
                $msHeaders[$lower] = $v;
            }
        }
        ksort($msHeaders);
        foreach ($msHeaders as $k => $v) {
            $canonicalizedHeaders .= "{$k}:{$v}\n";
        }

        // Canonicalized resource
        $cleanPath = ltrim($path, '/');
        $canonicalizedResource = "/{$this->accountName}/{$this->container}" . ($cleanPath ? "/{$cleanPath}" : '');

        $stringToSign = strtoupper($method) . "\n" // HTTP Verb
            . "\n" // Content-Encoding
            . "\n" // Content-Language
            . ($contentLength !== '' ? $contentLength : '') . "\n" // Content-Length
            . "\n" // Content-MD5
            . ($contentType !== '' ? $contentType : '') . "\n" // Content-Type
            . "\n" // Date
            . "\n" // If-Modified-Since
            . "\n" // If-Match
            . "\n" // If-None-Match
            . "\n" // If-Unmodified-Since
            . "\n" // Range
            . $canonicalizedHeaders
            . $canonicalizedResource;

        $key = base64_decode($this->accountKey, true) ?: $this->accountKey;
        $signature = base64_encode(hash_hmac('sha256', $stringToSign, $key, true));

        $headers['Authorization'] = "SharedKey {$this->accountName}:{$signature}";
        if ($contentType !== '') {
            $headers['Content-Type'] = $contentType;
        }

        return $headers;
    }

    public function fileExists(string $path): bool
    {
        try {
            $url = "{$this->baseUrl}/" . ltrim($path, '/');
            $headers = $this->getHeaders('HEAD', $path);
            $response = $this->client->head($url, ['headers' => $headers]);
            return $response->getStatusCode() === 200;
        } catch (ClientException $e) {
            if ($e->getResponse()?->getStatusCode() === 404) {
                return false;
            }
            throw UnableToCheckExistence::forLocation($path, $e);
        } catch (\Throwable $e) {
            throw UnableToCheckExistence::forLocation($path, $e);
        }
    }

    public function directoryExists(string $path): bool
    {
        return false;
    }

    public function write(string $path, string $contents, Config $config): void
    {
        try {
            $url = "{$this->baseUrl}/" . ltrim($path, '/');
            $length = (string) strlen($contents);
            $mime = (string) ($config->get('ContentType') ?: 'application/octet-stream');
            $headers = $this->getHeaders('PUT', $path, [
                'x-ms-blob-type' => 'BlockBlob',
            ], $length, $mime);

            $this->client->put($url, [
                'headers' => $headers,
                'body' => $contents,
            ]);
        } catch (\Throwable $e) {
            throw UnableToWriteFile::atLocation($path, $e->getMessage(), $e);
        }
    }

    public function writeStream(string $path, $contents, Config $config): void
    {
        $this->write($path, stream_get_contents($contents), $config);
    }

    public function read(string $path): string
    {
        try {
            $url = "{$this->baseUrl}/" . ltrim($path, '/');
            $headers = $this->getHeaders('GET', $path);
            $response = $this->client->get($url, ['headers' => $headers]);
            return (string) $response->getBody();
        } catch (\Throwable $e) {
            throw UnableToReadFile::fromLocation($path, $e->getMessage(), $e);
        }
    }

    public function readStream(string $path)
    {
        $contents = $this->read($path);
        $stream = fopen('php://temp', 'w+b');
        fwrite($stream, $contents);
        rewind($stream);
        return $stream;
    }

    public function delete(string $path): void
    {
        try {
            $url = "{$this->baseUrl}/" . ltrim($path, '/');
            $headers = $this->getHeaders('DELETE', $path);
            $this->client->delete($url, ['headers' => $headers]);
        } catch (ClientException $e) {
            if ($e->getResponse()?->getStatusCode() === 404) {
                return;
            }
            throw UnableToDeleteFile::atLocation($path, $e->getMessage(), $e);
        } catch (\Throwable $e) {
            throw UnableToDeleteFile::atLocation($path, $e->getMessage(), $e);
        }
    }

    public function deleteDirectory(string $path): void
    {
        // Flat blob namespace
    }

    public function createDirectory(string $path, Config $config): void
    {
        // Flat blob namespace
    }

    public function setVisibility(string $path, string $visibility): void
    {
        // Determined at container level
    }

    public function visibility(string $path): FileAttributes
    {
        return new FileAttributes($path, null, 'private');
    }

    public function mimeType(string $path): FileAttributes
    {
        return new FileAttributes($path, null, null, null, 'application/octet-stream');
    }

    public function lastModified(string $path): FileAttributes
    {
        return new FileAttributes($path, null, null, time());
    }

    public function fileSize(string $path): FileAttributes
    {
        return new FileAttributes($path, 0);
    }

    public function listContents(string $path, bool $deep): iterable
    {
        return [];
    }

    public function move(string $source, string $destination, Config $config): void
    {
        $this->copy($source, $destination, $config);
        $this->delete($source);
    }

    public function copy(string $source, string $destination, Config $config): void
    {
        $this->write($destination, $this->read($source), $config);
    }
}
