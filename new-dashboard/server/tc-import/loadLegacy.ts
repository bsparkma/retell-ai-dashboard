/**
 * TC legacy importer — data-directory loader.
 *
 * Reads the legacy TC-app `server/data/` directory READ-ONLY and returns the
 * raw parsed JSON plus an index of the image files. No mapping happens here.
 *
 * Exclusions (per PRD / Slice 1):
 *  - migrations.json      — legacy bookkeeping, dropped
 *  - practice.json        — platform office config supersedes it
 *  - users.json           — SSO owns identity; consumed ONLY for the id map
 *  - handoffs.json        — never implemented in TC-app
 *  - *.backup-*           — editor backup snapshots
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ImageFileIndex {
  /** posix-style relative path (e.g. "gallery-images/x.jpg") → file info */
  files: Map<string, { absPath: string; bytes: number }>;
  /** per-directory inventory for the report */
  dirs: { dir: string; count: number; bytes: number }[];
}

export interface LegacyDataDir {
  cases: unknown[];
  preauth: unknown[];
  templates: unknown[];
  communications: unknown[];
  gallery: unknown[];
  simulations: unknown[];
  library: unknown | null;
  users: unknown[];
  images: ImageFileIndex;
  excludedFiles: string[];
  unknownFiles: string[];
}

const CONSUMED_FILES: Record<string, keyof Pick<
  LegacyDataDir,
  "cases" | "preauth" | "templates" | "communications" | "gallery" | "simulations" | "users"
>> = {
  "cases.json": "cases",
  "preauth.json": "preauth",
  "templates.json": "templates",
  "communications.json": "communications",
  "gallery.json": "gallery",
  "smile-simulations.json": "simulations",
  "users.json": "users",
};

const EXCLUDED_FILES = new Set(["migrations.json", "practice.json", "handoffs.json"]);
const IMAGE_DIRS = ["gallery-images", "smile-sim-images", "email-images"];

function readJsonArray(file: string): unknown[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(file)}: expected a JSON array`);
  }
  return parsed;
}

export function loadLegacyDataDir(dataDir: string): LegacyDataDir {
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`legacy data directory not found: ${dataDir}`);
  }

  const out: LegacyDataDir = {
    cases: [],
    preauth: [],
    templates: [],
    communications: [],
    gallery: [],
    simulations: [],
    library: null,
    users: [],
    images: { files: new Map(), dirs: [] },
    excludedFiles: [],
    unknownFiles: [],
  };

  for (const name of fs.readdirSync(dataDir)) {
    const abs = path.join(dataDir, name);
    const stat = fs.statSync(abs);

    if (stat.isDirectory()) {
      if (!IMAGE_DIRS.includes(name)) out.unknownFiles.push(name + "/");
      continue;
    }
    if (/\.backup-/i.test(name) || EXCLUDED_FILES.has(name)) {
      out.excludedFiles.push(name);
      continue;
    }
    if (name === "library.json") {
      out.library = JSON.parse(fs.readFileSync(abs, "utf8"));
      continue;
    }
    const slot = CONSUMED_FILES[name];
    if (slot) {
      out[slot] = readJsonArray(abs);
      continue;
    }
    out.unknownFiles.push(name);
  }

  for (const dir of IMAGE_DIRS) {
    const abs = path.join(dataDir, dir);
    let count = 0;
    let bytes = 0;
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs)) {
        const fileAbs = path.join(abs, f);
        if (!fs.statSync(fileAbs).isFile()) continue;
        const size = fs.statSync(fileAbs).size;
        out.images.files.set(`${dir}/${f}`, { absPath: fileAbs, bytes: size });
        count += 1;
        bytes += size;
      }
    }
    out.images.dirs.push({ dir, count, bytes });
  }

  return out;
}

/** Map an image extension to its content type (unknown ext → octet-stream). */
export function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

/**
 * Normalize a legacy image reference ("gallery-images/x.jpg",
 * "/smile-sim-images/y.png", backslashes tolerated) to the index's
 * posix-relative form.
 */
export function normalizeImageRef(ref: string): string {
  return ref.replace(/\\/g, "/").replace(/^\/+/, "");
}
