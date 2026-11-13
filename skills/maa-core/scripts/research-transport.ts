import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * HTTP GET transports for the research readers. They only move bytes: one GET, the given headers,
 * no body, no redirects followed, a size cap and a time limit. Decoding, classification, rate limits,
 * stops and caching belong to the single reading core, so each platform has exactly one transport and
 * a failure never switches to another one.
 */
export type TransportRequest = { url: string; headers: Record<string, string> };
export type TransportResponse = { status: number; location: string | null; contentType: string | null; body: Buffer };
export type TransportLimits = { timeoutMs: number; maxBytes: number };
export type ResearchTransport = { name: 'fetch' | 'windows'; get(request: TransportRequest, limits: TransportLimits): Promise<TransportResponse> };
/** Errors carry only these codes, never response text, header values or the request headers. */
export type TransportError = 'transport-timeout' | 'transport-too-large' | 'transport-failed' | 'transport-unavailable';

const failure = (code: TransportError) => new Error(code);
const ascii = (value: string) => /^[\x20-\x7e]*$/.test(value);
function validate(request: TransportRequest, limits: TransportLimits) {
  let url: URL;
  try { url = new URL(request.url); } catch { throw failure('transport-failed'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.href !== request.url || !ascii(request.url)
    || Object.entries(request.headers).some(([name, value]) => !/^[A-Za-z0-9-]+$/.test(name) || !ascii(value))
    || !(limits.timeoutMs > 0) || !(limits.maxBytes > 0)) throw failure('transport-failed');
}

/** Node's own HTTP client; used outside Windows. */
export const fetchTransport: ResearchTransport = {
  name: 'fetch',
  async get(request, limits) {
    validate(request, limits);
    const signal = AbortSignal.timeout(limits.timeoutMs);
    const failed = () => failure(signal.aborted ? 'transport-timeout' : 'transport-failed');
    let response: Response;
    try { response = await fetch(request.url, { method: 'GET', redirect: 'manual', headers: request.headers, signal }); } catch { throw failed(); }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.maxBytes) { await response.body?.cancel().catch(() => undefined); throw failure('transport-too-large'); }
    const chunks: Uint8Array[] = []; let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          let next: ReadableStreamReadResult<Uint8Array>;
          try { next = await reader.read(); } catch { throw failed(); }
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > limits.maxBytes) { await reader.cancel().catch(() => undefined); throw failure('transport-too-large'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    return { status: response.status, location: response.headers.get('location'), contentType: response.headers.get('content-type'), body: Buffer.concat(chunks, bytes) };
  },
};

/*
 * Windows: the operating system's HTTP stack through Windows PowerShell 5.1 and .NET HttpClient, so the
 * user's system proxy and certificate store apply as in the browser the Cookie came from. The request,
 * including the Cookie header, travels only on the child's standard input; the response comes back as
 * base64 on standard output. Neither appears on a command line, in the environment or in an error.
 */
const script = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Net.Http
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $handler.UseCookies = $false
  $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
  $cancel = New-Object System.Threading.CancellationTokenSource
  $cancel.CancelAfter([int]$request.timeoutMs)
  $message = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, [Uri]$request.url)
  foreach ($header in $request.headers.PSObject.Properties) { [void]$message.Headers.TryAddWithoutValidation($header.Name, [string]$header.Value) }
  $response = $client.SendAsync($message, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
  $declared = $response.Content.Headers.ContentLength
  if ($declared -ne $null -and $declared -gt [long]$request.maxBytes) { exit 5 }
  $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  $memory = New-Object System.IO.MemoryStream
  $buffer = New-Object byte[] 65536
  while ($true) {
    $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()
    if ($read -le 0) { break }
    if ($memory.Length + $read -gt [long]$request.maxBytes) { exit 5 }
    $memory.Write($buffer, 0, $read)
  }
  $location = ''
  if ($response.Headers.Location -ne $null) { $location = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($response.Headers.Location.OriginalString)) }
  $type = ''
  if ($response.Content.Headers.ContentType -ne $null) { $type = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($response.Content.Headers.ContentType.ToString())) }
  [Console]::Out.Write((@{ status = [int]$response.StatusCode; location = $location; contentType = $type; body = [Convert]::ToBase64String($memory.ToArray()) } | ConvertTo-Json -Compress))
} catch {
  $e = $_.Exception
  while ($e) { if ($e -is [OperationCanceledException]) { exit 6 }; $e = $e.InnerException }
  exit 4
}`;
const startupAllowanceMs = 15_000;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const windowsTransport: ResearchTransport = {
  name: 'windows',
  get(request, limits) {
    validate(request, limits);
    if (process.platform !== 'win32' || !process.env.SystemRoot) return Promise.reject(failure('transport-unavailable'));
    const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const maximumOutput = Math.ceil(limits.maxBytes / 3) * 4 + 65_536;
    return new Promise((resolve, reject) => {
      let settled = false; let output = '';
      const finish = (error: Error | undefined, value?: TransportResponse) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value!); };
      let child;
      try {
        child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { finish(failure('transport-unavailable')); return; }
      const timer = setTimeout(() => { child.kill(); finish(failure('transport-timeout')); }, limits.timeoutMs + startupAllowanceMs);
      child.on('error', () => finish(failure('transport-unavailable')));
      child.stdout.setEncoding('ascii');
      child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > maximumOutput) { child.kill(); finish(failure('transport-too-large')); } });
      child.stdin.on('error', () => undefined);
      child.on('close', (code) => {
        if (code === 5) { finish(failure('transport-too-large')); return; }
        if (code === 6) { finish(failure('transport-timeout')); return; }
        if (code !== 0) { finish(failure('transport-failed')); return; }
        try {
          const value = JSON.parse(output) as Record<string, unknown>;
          const text = (field: unknown) => typeof field === 'string' && base64.test(field) ? field : undefined;
          const body = text(value.body), location = text(value.location), contentType = text(value.contentType);
          if (!Number.isInteger(value.status) || body === undefined || location === undefined || contentType === undefined) throw new Error('shape');
          const decoded = Buffer.from(body, 'base64');
          if (decoded.length > limits.maxBytes) { finish(failure('transport-too-large')); return; }
          finish(undefined, { status: value.status as number, body: decoded,
            location: location ? Buffer.from(location, 'base64').toString('utf8') : null, contentType: contentType ? Buffer.from(contentType, 'base64').toString('utf8') : null });
        } catch { finish(failure('transport-failed')); }
      });
      child.stdin.end(JSON.stringify({ url: request.url, headers: request.headers, timeoutMs: limits.timeoutMs, maxBytes: limits.maxBytes }));
    });
  },
};

/** The one transport for this platform. There is deliberately no fallback to the other one. */
export function platformTransport(platform: NodeJS.Platform = process.platform): ResearchTransport {
  return platform === 'win32' ? windowsTransport : fetchTransport;
}
