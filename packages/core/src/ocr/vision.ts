/**
 * Apple Vision OCR — on-device, free, no GPU, Apple-Silicon native. Closes Vortex's "image-only page /
 * scanned PDF" gap (those extract to ~empty prose and get dropped as "thin"). macOS only; degrades to a
 * clear unavailable() everywhere else. The Swift source is embedded below (String.raw, so backslashes in
 * Swift string literals survive) and lazy-compiled to a cached binary on first use — no build-step change.
 *
 * Keep SWIFT_SRC in sync with ./vision-ocr.swift (the human-readable copy).
 */
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SWIFT_SRC = String.raw`
import Foundation
import Vision
import PDFKit
import CoreGraphics

func ocr(_ cg: CGImage) -> String {
  var out = ""
  let req = VNRecognizeTextRequest { req, _ in
    guard let obs = req.results as? [VNRecognizedTextObservation] else { return }
    for o in obs { if let t = o.topCandidates(1).first { out += t.string + "\n" } }
  }
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
  return out
}
func loadImage(_ p: String) -> CGImage? {
  guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: p) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(s, 0, nil)
}
func renderPage(_ pg: PDFPage, _ scale: CGFloat = 2.0) -> CGImage? {
  let r = pg.bounds(for: .mediaBox)
  let w = Int(r.width * scale), h = Int(r.height * scale)
  guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  pg.draw(with: .mediaBox, to: ctx)
  return ctx.makeImage()
}
let a = CommandLine.arguments
guard a.count >= 2 else { FileHandle.standardError.write("usage: vision-ocr <file>\n".data(using: .utf8)!); exit(2) }
let p = a[1], ext = (p as NSString).pathExtension.lowercased()
var out = ""
if ext == "pdf" {
  if let doc = PDFDocument(url: URL(fileURLWithPath: p)) {
    for i in 0..<doc.pageCount { if let pg = doc.page(at: i), let img = renderPage(pg) { out += ocr(img) + "\n" } }
  }
} else if let img = loadImage(p) { out = ocr(img) }
print(out)
`;

const CACHE_DIR = process.env.VORTEX_TRACKER_DIR || path.join(os.homedir(), '.vortex-tracker');
const BIN_PATH = path.join(CACHE_DIR, 'bin', 'vision-ocr');

let availability: boolean | null = null;
let buildPromise: Promise<string> | null = null;

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/which', [cmd], (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

/** True only on macOS with swiftc present (or an already-built binary). Cached after first check. */
export async function ocrAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  if (process.platform !== 'darwin') { availability = false; return false; }
  if (existsSync(BIN_PATH)) { availability = true; return true; }
  availability = (await which('swiftc')) !== null;
  return availability;
}

/** Compile the Swift OCR binary once, cache it under VORTEX_TRACKER_DIR/bin. Idempotent + concurrency-safe. */
async function ensureBinary(): Promise<string> {
  if (existsSync(BIN_PATH)) return BIN_PATH;
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    await fs.mkdir(path.dirname(BIN_PATH), { recursive: true });
    const src = path.join(os.tmpdir(), `vortex-vision-ocr-${process.pid}.swift`);
    await fs.writeFile(src, SWIFT_SRC, 'utf8');
    await new Promise<void>((resolve, reject) => {
      execFile('swiftc', ['-O', src, '-o', BIN_PATH], (err, _o, stderr) => {
        if (err) reject(new Error(`swiftc failed: ${(stderr || err.message).slice(0, 200)}`));
        else resolve();
      });
    });
    await fs.unlink(src).catch(() => {});
    return BIN_PATH;
  })();
  try { return await buildPromise; } finally { buildPromise = null; }
}

/** OCR a local image or PDF file → recognized text. Throws if OCR is unavailable on this platform. */
export async function ocrFile(filePath: string): Promise<string> {
  if (!(await ocrAvailable())) throw new Error('OCR unavailable (needs macOS + swiftc)');
  const bin = await ensureBinary();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [filePath]);
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`vision-ocr exit ${code}: ${err.slice(0, 200)}`))));
  });
}

const EXT_BY_CT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/tiff': 'tiff', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif', 'image/bmp': 'bmp',
};

export interface OcrUrlResult { url: string; text: string; bytes: number; contentType: string; }

/**
 * Download an image/PDF URL and OCR it. For the asset itself (a scanned PDF, an infographic PNG) — NOT for
 * HTML pages (use the browser/extract path for those). Returns recognized text + basic metadata.
 */
export async function ocrUrl(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<OcrUrlResult> {
  if (!(await ocrAvailable())) throw new Error('OCR unavailable (needs macOS + swiftc)');
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const maxBytes = opts?.maxBytes ?? 25 * 1024 * 1024;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const urlExt = url.split('?')[0].split('.').pop()?.toLowerCase() || '';
  const ext = EXT_BY_CT[ct] || (['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'webp', 'heic', 'gif', 'bmp'].includes(urlExt) ? urlExt : '');
  if (!ext) throw new Error(`not an OCR-able asset (content-type "${ct}", url ext "${urlExt}")`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`asset too large (${buf.length} bytes > ${maxBytes})`);
  const tmp = path.join(os.tmpdir(), `vortex-ocr-${process.pid}-${Date.now()}.${ext}`);
  await fs.writeFile(tmp, buf);
  try {
    const text = await ocrFile(tmp);
    return { url, text, bytes: buf.length, contentType: ct || `inferred/${ext}` };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Is this URL likely an OCR-able asset (by extension)? Cheap pre-check before reaching for OCR. */
export function looksOcrable(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() || '';
  return ['pdf', 'png', 'jpg', 'jpeg', 'tiff', 'webp', 'heic', 'gif', 'bmp'].includes(ext);
}
