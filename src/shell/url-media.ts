/**
 * Startup media supplied through the page query string.
 *
 * Supported parameters:
 *   ?snap=<url>
 *   ?disk0=<url>&disk1=<url>...
 *   ?tape=<url>
 *
 * A snapshot is applied first because it may rebuild the active machine.
 * Disks follow in ascending unit order, then tape. The downloaded filename
 * drives the existing machine MediaService routing exactly like drag/drop.
 */

import { loadFile } from '@/shell/media.ts';
import { setStatus } from '@/shell/context.ts';

export type StartupMediaKind = 'snapshot' | 'disk' | 'tape';

export interface StartupMediaRequest {
  readonly param: string;
  readonly kind: StartupMediaKind;
  readonly url: string;
  readonly unit?: number;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StartupMediaDependencies {
  readonly baseUrl?: string;
  readonly fetch?: (url: string) => Promise<FetchResponse>;
  readonly load?: (data: Uint8Array, filename: string, unit?: number) => Promise<void>;
  readonly status?: (message: string) => void;
}

/** Parse and order the URL-media parameters. Empty values are ignored. */
export function parseStartupMedia(search: string): StartupMediaRequest[] {
  const params = new URLSearchParams(search);
  const out: StartupMediaRequest[] = [];

  const snap = params.get('snap')?.trim();
  if (snap) out.push({ param: 'snap', kind: 'snapshot', url: snap });

  const disks: StartupMediaRequest[] = [];
  for (const [param, raw] of params.entries()) {
    const match = /^disk(\d+)$/i.exec(param);
    const url = raw.trim();
    if (!match || !url) continue;
    const unit = Number(match[1]);
    if (!Number.isSafeInteger(unit)) continue;
    disks.push({ param, kind: 'disk', url, unit });
  }
  disks.sort((a, b) => a.unit! - b.unit!);
  out.push(...disks);

  const tape = params.get('tape')?.trim();
  if (tape) out.push({ param: 'tape', kind: 'tape', url: tape });
  return out;
}

function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim()); } catch { return encoded[1].trim(); }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(header);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

function filenameFromUrl(url: URL, response: FetchResponse, param: string): string {
  const disposition = contentDispositionFilename(response.headers.get('content-disposition'));
  if (disposition) return disposition;
  const finalUrl = response.url ? new URL(response.url, url) : url;
  const segment = finalUrl.pathname.split('/').pop();
  if (segment) {
    try { return decodeURIComponent(segment); } catch { return segment; }
  }
  return param;
}

/**
 * Fetch and mount every supported URL parameter. Individual failures do not
 * prevent the remaining media from loading.
 */
export async function loadStartupMedia(
  search: string,
  dependencies: StartupMediaDependencies = {},
): Promise<void> {
  const requests = parseStartupMedia(search);
  if (requests.length === 0) return;

  const baseUrl = dependencies.baseUrl
    ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
  const fetchMedia = dependencies.fetch
    ?? ((url: string) => fetch(url) as unknown as Promise<FetchResponse>);
  const mount = dependencies.load ?? loadFile;
  const report = dependencies.status ?? setStatus;
  let failed = 0;

  for (const request of requests) {
    try {
      const url = new URL(request.url, baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`unsupported URL protocol ${url.protocol}`);
      }

      report(`Fetching ${request.param}…`);
      const response = await fetchMedia(url.href);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      const filename = filenameFromUrl(url, response, request.param);
      await mount(data, filename, request.unit);
    } catch (error) {
      failed++;
      const message = `${request.param}: ${(error as Error).message}`;
      console.warn(`URL media load failed — ${message}`);
      report(`URL media load failed — ${message}`);
    }
  }

  if (failed > 1) report(`${failed} URL media loads failed — see console`);
}
