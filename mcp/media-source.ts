/**
 * Resolve an MCP media argument from either a local path or an HTTP(S) URL.
 *
 * Media routing depends on the filename extension, so redirects and download
 * endpoints may supply the name through Content-Disposition.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ResolvedMediaSource {
  readonly data: Uint8Array;
  readonly filename: string;
  readonly source: string;
}

export type MediaFetcher = (url: string) => Promise<FetchResponse>;

function safeBasename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() || 'download';
}

function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try { return safeBasename(decodeURIComponent(encoded[1].trim())); }
    catch { return safeBasename(encoded[1].trim()); }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
  return plain ? safeBasename((plain[1] ?? plain[2]).trim()) : null;
}

function urlFilename(requestUrl: URL, response: FetchResponse): string {
  const disposition = dispositionFilename(response.headers.get('content-disposition'));
  if (disposition) return disposition;
  const finalUrl = response.url ? new URL(response.url, requestUrl) : requestUrl;
  const encoded = finalUrl.pathname.split('/').pop();
  if (!encoded) return 'download';
  try { return safeBasename(decodeURIComponent(encoded)); }
  catch { return safeBasename(encoded); }
}

export async function resolveMediaSource(
  input: string,
  fetcher: MediaFetcher = (url) => fetch(url) as unknown as Promise<FetchResponse>,
): Promise<ResolvedMediaSource> {
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    const response = await fetcher(url.href);
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} (${url.href})`);
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      filename: urlFilename(url, response),
      source: url.href,
    };
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    throw new Error(`Unsupported media URL protocol: ${new URL(input).protocol}`);
  }
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);
  return {
    data: new Uint8Array(fs.readFileSync(input)),
    filename: path.basename(input),
    source: path.resolve(input),
  };
}
