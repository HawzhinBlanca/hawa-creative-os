import Cocoa
import Vision

struct BoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct RecognizedBlock: Codable {
    let text: String
    let confidence: Float
    let box: BoundingBox
}

struct GraphicVisionData: Codable {
    let filename: String
    let width: Int
    let height: Int
    let aspectRatio: Double
    let formatCategory: String
    let isKurdish: Bool
    let textBlocks: [RecognizedBlock]
    let fullText: String
}

let graphicsDir = "/Users/hawzhin/Hawdesign/data/kaae-graphics/references/KAAE Archives /Graphics"
let outputJson = "/Users/hawzhin/Hawdesign/data/kaae-graphics/extracted-tokens/archive_graphics_vision_analysis.json"

let fileManager = FileManager.default
guard let files = try? fileManager.contentsOfDirectory(atPath: graphicsDir) else {
    print("Failed to list directory: \(graphicsDir)")
    exit(1)
}

let validFiles = files.filter { f in
    let ext = (f as NSString).pathExtension.lowercased()
    return ["jpg", "jpeg", "png"].contains(ext) && !f.hasPrefix(".")
}.sorted()

print("Found \(validFiles.count) graphic design files to deep-learn...")

var allResults: [GraphicVisionData] = []

for (index, file) in validFiles.enumerated() {
    let fullPath = (graphicsDir as NSString).appendingPathComponent(file)
    guard let image = NSImage(contentsOfFile: fullPath),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("[\(index + 1)/\(validFiles.count)] Skipping unreadable: \(file)")
        continue
    }
    
    let width = cgImage.width
    let height = cgImage.height
    let ratio = Double(width) / Double(height)
    
    var category = "custom"
    if abs(ratio - 1.0) < 0.05 {
        category = "1:1 Square"
    } else if abs(ratio - 0.8) < 0.05 {
        category = "4:5 Portrait Feed"
    } else if abs(ratio - 0.5625) < 0.05 {
        category = "9:16 Vertical Story"
    } else if abs(ratio - 1.777) < 0.05 {
        category = "16:9 Widescreen"
    } else if abs(ratio - 1.414) < 0.05 || abs(ratio - 0.707) < 0.05 {
        category = "A4 Document"
    } else if abs(ratio - 1.25) < 0.05 {
        category = "5:4 Presentation Slide"
    }
    
    let isKurdish = file.lowercased().contains("kurdi") || file.lowercased().contains("krd")
    
    var blocks: [RecognizedBlock] = []
    
    let request = VNRecognizeTextRequest { (req, err) in
        guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
        for obs in observations {
            if let top = obs.topCandidates(1).first {
                let box = BoundingBox(
                    x: obs.boundingBox.origin.x,
                    y: obs.boundingBox.origin.y,
                    width: obs.boundingBox.size.width,
                    height: obs.boundingBox.size.height
                )
                blocks.append(RecognizedBlock(text: top.string, confidence: top.confidence, box: box))
            }
        }
    }
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US", "ar-SA"]
    request.usesLanguageCorrection = true
    
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    
    let fullText = blocks.map { $0.text }.joined(separator: "\n")
    
    let entry = GraphicVisionData(
        filename: file,
        width: width,
        height: height,
        aspectRatio: (ratio * 1000).rounded() / 1000,
        formatCategory: category,
        isKurdish: isKurdish,
        textBlocks: blocks,
        fullText: fullText
    )
    allResults.append(entry)
    print("[\(index + 1)/\(validFiles.count)] Analyzed \(file) (\(blocks.count) text lines, \(category))")
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
if let data = try? encoder.encode(allResults) {
    let outUrl = URL(fileURLWithPath: outputJson)
    try? data.write(to: outUrl)
    print("Successfully deep-learned \(allResults.count) graphics. Saved to \(outputJson)")
} else {
    print("Failed to encode JSON results.")
}
