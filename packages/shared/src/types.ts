/** Detected part info from a distributor page */
export interface DetectedPart {
  mpn: string;
  manufacturer?: string;
  description?: string;
  lcscId?: string;
  source: 'digikey' | 'lcsc' | 'selection';
  pageUrl: string;
  /** Set by the "Search highlighted text" command: search as soon as the finder opens. */
  autoSearch?: boolean;
}

/** File availability from a component source */
export interface ComponentAvailability {
  source: 'easyeda' | 'snapeda' | 'cse' | 'ultralibrarian';
  hasSymbol: boolean;
  hasFootprint: boolean;
  has3DModel: boolean;
  downloadUrl?: string;
  searchUrl?: string;
}

/** A single KiCad-compatible component file */
export interface ComponentFile {
  filename: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  type: 'symbol' | 'footprint' | '3dmodel';
}

/** Request to install component files into KiCad libraries */
export interface InstallRequest {
  mpn: string;
  manufacturer?: string;
  lcscId?: string;
  files: ComponentFile[];
}

/** Result of an install operation */
export interface InstallResult {
  success: boolean;
  installed: {
    type: ComponentFile['type'];
    path: string;
  }[];
  libraryTablesUpdated: boolean;
  errors: string[];
}

/** Server configuration */
export interface ServerConfig {
  port: number;
  kicadVersion: string;
  libraryMode: 'global' | 'project';
  paths: {
    symbolDir: string;
    footprintDir: string;
    model3dDir: string;
    globalConfigDir: string;
    projectDir: string | null;
  };
  libraryName: string;
  converterPath: string;
}

/** Health check response */
export interface HealthResponse {
  ok: boolean;
  version: string;
  kicadDetected: boolean;
  converterAvailable: boolean;
  converterVersion?: string;
}

/** Messages between content script and extension */
export type ExtensionMessage =
  | { type: 'PART_DETECTED'; part: DetectedPart }
  | { type: 'NO_PART_FOUND' }
  | { type: 'REQUEST_SCAN' };
