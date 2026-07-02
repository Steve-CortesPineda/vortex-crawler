// Vortex OCR — Apple Vision (VNRecognizeTextRequest) + PDFKit. On-device, free, no GPU, Apple-Silicon native.
// Input: one file path (image: png/jpg/tiff/heic/… or a .pdf). Output: recognized text to stdout.
// NOTE: this file is the human-readable canonical copy. The SAME source is embedded in vision.ts
// (String.raw) for lazy compile at runtime — keep the two in sync.
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
