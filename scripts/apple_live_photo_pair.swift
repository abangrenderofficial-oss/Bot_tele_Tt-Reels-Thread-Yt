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

    // Real Apple Live Photo MOV files use 0xFF / -1 as the payload. The actual
    // still frame position is carried by this timed metadata sample's PTS.
    item.value = NSNumber(value: Int8(-1))
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
        allocator: kCFAllocatorDefault,
        metadataType: kCMMetadataFormatType_Boxed,
        metadataSpecifications: [specification] as CFArray,
        formatDescriptionOut: &formatDescription
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
    guard let rawVideoFormat = videoTrack.formatDescriptions.first else {
        throw PairError.message("Could not read source video format description.")
    }
    let videoFormat = rawVideoFormat as! CMFormatDescription

    let reader = try AVAssetReader(asset: asset)
    let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    videoOutput.alwaysCopiesSampleData = false
    try require(reader.canAdd(videoOutput), "Could not add video reader output.")
    reader.add(videoOutput)

    let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
    writer.movieTimeScale = 600

    let videoInput = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: nil,
        sourceFormatHint: videoFormat
    )
    videoInput.expectsMediaDataInRealTime = false
    videoInput.transform = videoTrack.preferredTransform
    try require(writer.canAdd(videoInput), "Could not add video writer input.")
    writer.add(videoInput)

    // Live Wallpaper does not require an audio track. Keeping the native pairer
    // video-only avoids AVAssetWriter back-pressure/deadlocks when compressed
    // video and audio are copied sequentially on short ephemeral jobs.
    let metadataAdaptor = try stillImageTimeAdaptor()
    let metadataInput = metadataAdaptor.assetWriterInput
    try require(writer.canAdd(metadataInput), "Could not add still-image-time writer input.")
    writer.add(metadataInput)

    // This is the structural difference between an asset-level metadata track
    // and a metadata track that explicitly describes the video track. iOS Lock
    // Screen eligibility is stricter than Photos Live Photo recognition, so keep
    // the timed metadata associated with the video rather than the movie as a whole.
    let metadataReferent = AVAssetTrack.AssociationType.metadataReferent.rawValue
    try require(
        metadataInput.canAddTrackAssociation(withTrackOf: videoInput, type: metadataReferent),
        "Could not associate Live Photo metadata track with video track."
    )
    metadataInput.addTrackAssociation(withTrackOf: videoInput, type: metadataReferent)

    writer.metadata = [contentIdentifierMetadata(identifier)]

    try require(writer.startWriting(), "AVAssetWriter could not start: \(writer.error?.localizedDescription ?? "unknown error")")
    writer.startSession(atSourceTime: .zero)
    try require(reader.startReading(), "AVAssetReader could not start: \(reader.error?.localizedDescription ?? "unknown error")")

    let durationSeconds = max(0.1, CMTimeGetSeconds(asset.duration))
    let stillSeconds = min(max(0.05, durationSeconds * 0.5), max(0.05, durationSeconds - 0.05))

    // Match the shape of recent iPhone Live Photo files more closely: a 600 Hz
    // metadata timeline with one one-tick sample. The sample payload is -1; its
    // presentation timestamp is the actual still-image position.
    let stillTime = CMTime(seconds: stillSeconds, preferredTimescale: 600)
    let metadataTick = CMTime(value: 1, timescale: 600)
    let metadataGroup = AVTimedMetadataGroup(
        items: [stillImageTimeItem()],
        timeRange: CMTimeRange(start: stillTime, duration: metadataTick)
    )
    try require(metadataAdaptor.append(metadataGroup), "Could not append still-image-time metadata sample.")
    metadataInput.markAsFinished()

    var videoFinished = false
    while !videoFinished {
        if writer.status == .failed {
            throw PairError.message("Live Photo writer failed: \(writer.error?.localizedDescription ?? "unknown error")")
        }
        if reader.status == .failed {
            throw PairError.message("Live Photo reader failed: \(reader.error?.localizedDescription ?? "unknown error")")
        }
        if videoInput.isReadyForMoreMediaData {
            if let sample = videoOutput.copyNextSampleBuffer() {
                try require(videoInput.append(sample), "Could not append video sample: \(writer.error?.localizedDescription ?? "unknown error")")
            } else {
                videoInput.markAsFinished()
                videoFinished = true
            }
        } else {
            Thread.sleep(forTimeInterval: 0.002)
        }
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

func stillImageMetadataInfo(_ asset: AVAsset) -> (found: Bool, payload: Int, time: Double, duration: Double) {
    guard let metadataTrack = asset.tracks(withMediaType: .metadata).first,
          let reader = try? AVAssetReader(asset: asset) else {
        return (false, 0, 0, 0)
    }
    let output = AVAssetReaderTrackOutput(track: metadataTrack, outputSettings: nil)
    guard reader.canAdd(output) else { return (false, 0, 0, 0) }
    reader.add(output)
    guard reader.startReading() else { return (false, 0, 0, 0) }

    while let sample = output.copyNextSampleBuffer() {
        guard CMSampleBufferGetNumSamples(sample) > 0,
              let group = AVTimedMetadataGroup(sampleBuffer: sample) else { continue }
        for item in group.items {
            if item.key as? String == "com.apple.quicktime.still-image-time",
               item.keySpace?.rawValue == "mdta" {
                return (
                    true,
                    item.numberValue?.intValue ?? 0,
                    CMTimeGetSeconds(group.timeRange.start),
                    CMTimeGetSeconds(group.timeRange.duration)
                )
            }
        }
    }
    return (false, 0, 0, 0)
}

func metadataTrackReferencesVideo(_ asset: AVAsset) -> Bool {
    guard let metadataTrack = asset.tracks(withMediaType: .metadata).first,
          let videoTrack = asset.tracks(withMediaType: .video).first else {
        return false
    }

    let associated = metadataTrack.associatedTracks(ofType: .metadataReferent)
    return associated.contains { $0.trackID == videoTrack.trackID }
}

func verifyPair(photoURL: URL, movieURL: URL, expectedIdentifier: String) throws {
    try require(jpegIdentifier(photoURL) == expectedIdentifier, "Paired JPEG MakerApple[17] identifier verification failed.")
    let asset = AVURLAsset(url: movieURL)
    try require(movieIdentifier(asset) == expectedIdentifier, "Paired MOV content identifier verification failed.")

    let still = stillImageMetadataInfo(asset)
    try require(still.found, "Paired MOV still-image-time metadata verification failed.")
    try require(still.payload == -1, "Paired MOV still-image-time payload is not Apple-style -1.")
    try require(still.duration > 0 && still.duration <= (1.0 / 30.0), "Paired MOV still-image-time sample is too long.")
    try require(metadataTrackReferencesVideo(asset), "Paired MOV metadata track is not associated with the video track.")

    print(
        String(
            format: "APPLE_LIVE_PHOTO_STRUCTURE still=%.4fs metadata_sample=%.6fs referent=video payload=%d",
            still.time,
            still.duration,
            still.payload
        )
    )
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
