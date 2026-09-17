import Foundation
import AVFoundation
import CoreMedia
import CoreFoundation
import ImageIO
import UniformTypeIdentifiers

enum PairError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value): return value
        }
    }
}

func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw PairError.message(message) }
}

func removeIfExists(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
}

func pairJPEG(inputURL: URL, outputURL: URL, identifier: String) throws {
    removeIfExists(outputURL)
    guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            UTType.jpeg.identifier as CFString,
            1,
            nil
          ) else {
        throw PairError.message("Could not open JPEG resources for Live Photo pairing.")
    }

    var properties = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [AnyHashable: Any]) ?? [:]
    properties[kCGImagePropertyMakerAppleDictionary] = ["17": identifier]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw PairError.message("Could not write paired Live Photo JPEG metadata.")
    }
}

func contentIdentifierMetadata(_ identifier: String) -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.key = "com.apple.quicktime.content.identifier" as NSString
    item.keySpace = AVMetadataKeySpace(rawValue: "mdta")
    item.value = identifier as NSString
    item.dataType = "com.apple.metadata.datatype.UTF-8"
    return item
}

func stillImageTimeItem() -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.key = "com.apple.quicktime.still-image-time" as NSString
    item.keySpace = AVMetadataKeySpace(rawValue: "mdta")
    item.value = NSNumber(value: Int8(0))
    item.dataType = "com.apple.metadata.datatype.int8"
    return item
}

func stillImageTimeAdaptor() throws -> AVAssetWriterInputMetadataAdaptor {
    let specification: NSDictionary = [
        kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as NSString:
            "mdta/com.apple.quicktime.still-image-time",
        kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as NSString:
            "com.apple.metadata.datatype.int8"
    ]

    var formatDescription: CMFormatDescription?
    let status = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(
        kCFAllocatorDefault,
        kCMMetadataFormatType_Boxed,
        [specification] as CFArray,
        &formatDescription
    )
    guard status == noErr, let formatDescription else {
        throw PairError.message("Could not create Live Photo still-image-time metadata track.")
    }

    let input = AVAssetWriterInput(
        mediaType: .metadata,
        outputSettings: nil,
        sourceFormatHint: formatDescription
    )
    return AVAssetWriterInputMetadataAdaptor(assetWriterInput: input)
}

func pairMovie(inputURL: URL, outputURL: URL, identifier: String) throws {
    removeIfExists(outputURL)
    let asset = AVURLAsset(url: inputURL)
    guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        throw PairError.message("Source Live Photo movie has no video track.")
    }
    guard let videoFormat = videoTrack.formatDescriptions.first as? CMFormatDescription else {
        throw PairError.message("Could not read source video format description.")
    }

    let reader = try AVAssetReader(asset: asset)
    let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    videoOutput.alwaysCopiesSampleData = false
    try require(reader.canAdd(videoOutput), "Could not add video reader output.")
    reader.add(videoOutput)

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
    let videoInput = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: nil,
        sourceFormatHint: videoFormat
    )
    videoInput.expectsMediaDataInRealTime = false
    videoInput.transform = videoTrack.preferredTransform
    try require(writer.canAdd(videoInput), "Could not add video writer input.")
    writer.add(videoInput)

    var audioInput: AVAssetWriterInput?
    var audioOutput: AVAssetReaderTrackOutput?
    if let audioTrack = asset.tracks(withMediaType: .audio).first,
       let audioFormat = audioTrack.formatDescriptions.first as? CMFormatDescription {
        let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        if reader.canAdd(output) {
            reader.add(output)
            let input = AVAssetWriterInput(
                mediaType: .audio,
                outputSettings: nil,
                sourceFormatHint: audioFormat
            )
            input.expectsMediaDataInRealTime = false
            if writer.canAdd(input) {
                writer.add(input)
                audioInput = input
                audioOutput = output
            }
        }
    }

    let metadataAdaptor = try stillImageTimeAdaptor()
    try require(writer.canAdd(metadataAdaptor.assetWriterInput), "Could not add still-image-time writer input.")
    writer.add(metadataAdaptor.assetWriterInput)
    writer.metadata = [contentIdentifierMetadata(identifier)]

    try require(writer.startWriting(), "AVAssetWriter could not start: \(writer.error?.localizedDescription ?? "unknown error")")
    writer.startSession(atSourceTime: .zero)
    try require(reader.startReading(), "AVAssetReader could not start: \(reader.error?.localizedDescription ?? "unknown error")")

    let durationSeconds = max(0.1, CMTimeGetSeconds(asset.duration))
    let stillSeconds = min(max(0.05, durationSeconds * 0.5), max(0.05, durationSeconds - 0.05))
    let fps = videoTrack.nominalFrameRate > 0 ? Double(videoTrack.nominalFrameRate) : 30.0
    let stillTime = CMTime(seconds: stillSeconds, preferredTimescale: 60_000)
    let frameDuration = CMTime(seconds: 1.0 / fps, preferredTimescale: 60_000)
    let metadataGroup = AVTimedMetadataGroup(
        items: [stillImageTimeItem()],
        timeRange: CMTimeRange(start: stillTime, duration: frameDuration)
    )
    try require(metadataAdaptor.append(metadataGroup), "Could not append still-image-time metadata sample.")
    metadataAdaptor.assetWriterInput.markAsFinished()

    func copySamples(output: AVAssetReaderTrackOutput, input: AVAssetWriterInput) throws {
        var finished = false
        while !finished {
            if writer.status == .failed {
                throw PairError.message("Live Photo writer failed: \(writer.error?.localizedDescription ?? "unknown error")")
            }
            if reader.status == .failed {
                throw PairError.message("Live Photo reader failed: \(reader.error?.localizedDescription ?? "unknown error")")
            }
            if input.isReadyForMoreMediaData {
                if let sample = output.copyNextSampleBuffer() {
                    try require(input.append(sample), "Could not append media sample: \(writer.error?.localizedDescription ?? "unknown error")")
                } else {
                    input.markAsFinished()
                    finished = true
                }
            } else {
                Thread.sleep(forTimeInterval: 0.002)
            }
        }
    }

    // Video first is deliberate: the paired clip is short and capped below Telegram's 10 MB limit.
    // Copying compressed samples preserves the ffmpeg-prepared H.264 bitstream instead of re-encoding it.
    try copySamples(output: videoOutput, input: videoInput)
    if let audioInput, let audioOutput {
        try copySamples(output: audioOutput, input: audioInput)
    }

    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()
    try require(writer.status == .completed, "Live Photo MOV finalization failed: \(writer.error?.localizedDescription ?? "unknown error")")
}

func jpegIdentifier(_ url: URL) -> String? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [AnyHashable: Any],
          let maker = properties[kCGImagePropertyMakerAppleDictionary] as? [AnyHashable: Any] else {
        return nil
    }
    return maker["17"] as? String
}

func movieIdentifier(_ asset: AVAsset) -> String? {
    for item in asset.metadata(forFormat: .quickTimeMetadata) {
        if item.key as? String == "com.apple.quicktime.content.identifier",
           item.keySpace?.rawValue == "mdta" {
            return item.stringValue
        }
    }
    return nil
}

func movieHasStillImageTime(_ asset: AVAsset) -> Bool {
    guard let metadataTrack = asset.tracks(withMediaType: .metadata).first,
          let reader = try? AVAssetReader(asset: asset) else {
        return false
    }
    let output = AVAssetReaderTrackOutput(track: metadataTrack, outputSettings: nil)
    guard reader.canAdd(output) else { return false }
    reader.add(output)
    guard reader.startReading() else { return false }

    while let sample = output.copyNextSampleBuffer() {
        guard CMSampleBufferGetNumSamples(sample) > 0,
              let group = AVTimedMetadataGroup(sampleBuffer: sample) else { continue }
        for item in group.items {
            if item.key as? String == "com.apple.quicktime.still-image-time",
               item.keySpace?.rawValue == "mdta" {
                return true
            }
        }
    }
    return false
}

func verifyPair(photoURL: URL, movieURL: URL, expectedIdentifier: String) throws {
    try require(jpegIdentifier(photoURL) == expectedIdentifier, "Paired JPEG MakerApple[17] identifier verification failed.")
    let asset = AVURLAsset(url: movieURL)
    try require(movieIdentifier(asset) == expectedIdentifier, "Paired MOV content identifier verification failed.")
    try require(movieHasStillImageTime(asset), "Paired MOV still-image-time metadata verification failed.")
}

func main() throws {
    let args = CommandLine.arguments
    guard args.count == 5 else {
        throw PairError.message("Usage: apple_live_photo_pair.swift <input.jpg> <input.mov> <output.jpg> <output.mov>")
    }

    let inputPhoto = URL(fileURLWithPath: args[1])
    let inputMovie = URL(fileURLWithPath: args[2])
    let outputPhoto = URL(fileURLWithPath: args[3])
    let outputMovie = URL(fileURLWithPath: args[4])
    let identifier = UUID().uuidString

    try pairJPEG(inputURL: inputPhoto, outputURL: outputPhoto, identifier: identifier)
    try pairMovie(inputURL: inputMovie, outputURL: outputMovie, identifier: identifier)
    try verifyPair(photoURL: outputPhoto, movieURL: outputMovie, expectedIdentifier: identifier)

    print("APPLE_LIVE_PHOTO_OK identifier=\(identifier)")
}

do {
    try main()
} catch {
    let message = "APPLE_LIVE_PHOTO_ERROR: \(error)\n"
    FileHandle.standardError.write(message.data(using: .utf8) ?? Data())
    exit(1)
}
