/**
 * Companion server client — communicates with the local KiCad Part Server.
 * Auth: server generates a random token on first start. The extension reads
 * it from GET /health and includes it in all mutating requests (POST/PUT).
 */

import { SERVER_BASE_URL } from '@kicad-part-finder/shared';
import type { HealthResponse, InstallRequest, InstallResult, ServerConfig } from '@kicad-part-finder/shared';

let baseUrl = SERVER_BASE_URL;
let authToken: string | null = null;

export function setServerUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '');
  authToken = null; // Reset token when URL changes
}

export function getServerUrl(): string {
  return baseUrl;
}

/** Headers for mutating requests (POST/PUT) */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['X-Auth-Token'] = authToken;
  return headers;
}

/** Check if the companion server is running. Also caches the auth token. */
export async function checkHealth(): Promise<HealthResponse | null> {
  try {
    const resp = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Cache the auth token for subsequent requests
    if (data.authToken) authToken = data.authToken;
    return data;
  } catch {
    return null;
  }
}

/** Get server configuration */
export async function getConfig(): Promise<ServerConfig | null> {
  try {
    const resp = await fetch(`${baseUrl}/config`);
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

/** Update server configuration */
export async function updateConfig(config: Partial<ServerConfig>): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(config),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface VariantInfo {
  mpn: string;
  package: string;
  stock: number;
  price: number | null;
  lcscId: string;
  lcscUrl: string;
}

/** Search result from the companion server */
export interface SearchResult {
  found: boolean;
  lcscId?: string;
  title?: string;
  hasSymbol: boolean;
  hasFootprint: boolean;
  has3DModel: boolean;
  stock?: number;
  price?: number;
  package?: string;
  variants?: VariantInfo[];
}

/** Search for a component via the companion server (avoids CORS issues) */
export async function searchComponent(mpn: string, lcscId?: string): Promise<SearchResult> {
  const empty: SearchResult = { found: false, hasSymbol: false, hasFootprint: false, has3DModel: false };
  try {
    const params = new URLSearchParams();
    if (mpn) params.set('mpn', mpn);
    if (lcscId) params.set('lcscId', lcscId);

    const resp = await fetch(`${baseUrl}/search?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return empty;
    return resp.json();
  } catch {
    return empty;
  }
}

/** Upload a ZIP file (from SnapEDA, CSE, etc.) to the server for extraction and install */
export async function uploadZip(file: File, mpn?: string): Promise<InstallResult> {
  try {
    const buffer = await file.arrayBuffer();
    const params = mpn ? `?mpn=${encodeURIComponent(mpn)}` : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (authToken) headers['X-Auth-Token'] = authToken;

    const resp = await fetch(`${baseUrl}/upload${params}`, {
      method: 'POST',
      headers,
      body: buffer,
    });

    if (!resp.ok) {
      const error = await resp.text();
      return {
        success: false,
        installed: [],
        libraryTablesUpdated: false,
        errors: [`Server error (${resp.status}): ${error}`],
      };
    }

    return resp.json();
  } catch (err) {
    return {
      success: false,
      installed: [],
      libraryTablesUpdated: false,
      errors: [`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`],
    };
  }
}

/** Install component files into KiCad libraries */
export async function installComponent(request: InstallRequest): Promise<InstallResult> {
  try {
    const resp = await fetch(`${baseUrl}/install`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(request),
    });

    if (!resp.ok) {
      const error = await resp.text();
      return {
        success: false,
        installed: [],
        libraryTablesUpdated: false,
        errors: [`Server error (${resp.status}): ${error}`],
      };
    }

    return resp.json();
  } catch (err) {
    return {
      success: false,
      installed: [],
      libraryTablesUpdated: false,
      errors: [`Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`],
    };
  }
}
