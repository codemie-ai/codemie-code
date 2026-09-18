// Renders the two plugin glyphs — monochrome (black-on-transparent) 512×512
// PNGs — into Sources/codemie-codenotch/Resources/. Dependency-free; run from
// the package root:
//
//   swift Scripts/render-glyphs.swift
//
// Both marks are a bold "C" ring arc (the CodeMie budget ring); the Claude
// variant adds a small filled node sitting in the arc's gap.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 512
let outputDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("Sources/codemie-codenotch/Resources")

func makeContext() -> CGContext? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    return CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
}

func strokeArc(_ context: CGContext) {
    let center = CGPoint(x: size / 2, y: size / 2)
    let radius: CGFloat = 170
    // Gap on the right: 50°…310° counterclockwise (Quartz is y-up).
    context.addArc(center: center, radius: radius, startAngle: 50 * .pi / 180, endAngle: 310 * .pi / 180, clockwise: false)
    context.setStrokeColor(CGColor(gray: 0, alpha: 1))
    context.setLineWidth(64)
    context.setLineCap(.round)
    context.strokePath()
}

func fillNode(_ context: CGContext) {
    let center = CGPoint(x: size / 2 + 170, y: size / 2)
    context.addArc(center: center, radius: 58, startAngle: 0, endAngle: 2 * .pi, clockwise: false)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fillPath()
}

func writePNG(_ context: CGContext, to url: URL) throws {
    guard let image = context.makeImage() else {
        throw NSError(domain: "render-glyphs", code: 1, userInfo: [NSLocalizedDescriptionKey: "makeImage failed"])
    }
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "render-glyphs", code: 2, userInfo: [NSLocalizedDescriptionKey: "destination failed"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "render-glyphs", code: 3, userInfo: [NSLocalizedDescriptionKey: "finalize failed"])
    }
}

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

guard let budget = makeContext(), let claude = makeContext() else {
    FileHandle.standardError.write(Data("could not create graphics contexts\n".utf8))
    exit(1)
}

strokeArc(budget)
strokeArc(claude)
fillNode(claude)

let budgetURL = outputDir.appendingPathComponent("glyph-codemie-budget.png")
let claudeURL = outputDir.appendingPathComponent("glyph-codemie-claude.png")
try writePNG(budget, to: budgetURL)
try writePNG(claude, to: claudeURL)
print("wrote \(budgetURL.path)")
print("wrote \(claudeURL.path)")
