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
    var maker = (properties[kCGImagePropertyMakerAppleDictionary] as? [AnyHashable: Any]) ?? [:]
    maker["17"] = identifier
    properties[kCGImagePropertyMakerAppleDictionary] = maker
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        throw PairError.message("Could not write paired Live Photo JPEG metadata.")
    }
}

func quickTimeMetadata(_ key: String, value: Any, dataType: String) -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.key = key as NSString
    item.keySpace = AVMetadataKeySpace(rawValue: "mdta")
    item.value = value as? NSCopying
    item.dataType = dataType
    return item
}

let contentIdentifierKey = "com.apple.quicktime.content.identifier"
let autoLivePhotoKey = "com.apple.quicktime.live-photo.auto"
let vitalityScoreKey = "com.apple.quicktime.live-photo.vitality-score"
let vitalityVersionKey = "com.apple.quicktime.live-photo.vitality-scoring-version"

let requiredWallpaperIdentifiers: Set<String> = [
    "mdta/com.apple.quicktime.live-photo-info",
    "mdta/com.apple.quicktime.live-photo-still-image-transform",
    "mdta/com.apple.quicktime.still-image-time",
]

func stampPreparedMovie(inputURL: URL, outputURL: URL, identifier: String) throws {
    removeIfExists(outputURL)
    try FileManager.default.copyItem(at: inputURL, to: outputURL)

    // Header-only mutation is deliberate. Re-exporting a prepared Live Wallpaper
    // MOV can drop tref/cdsc relationships between the mebx metadata tracks and
    // the video track. AVMutableMovie.writeHeader preserves those track atoms.
    let movie = AVMutableMovie(
        url: outputURL,
        options: [AVURLAssetPreferPreciseDurationAndTimingKey: true]
    )

    let replacedKeys: Set<String> = [
        contentIdentifierKey,
        autoLivePhotoKey,
        vitalityScoreKey,
        vitalityVersionKey,
    ]
    let existing = movie.metadata.filter { item in
        guard item.keySpace?.rawValue == "mdta",
              let key = item.key as? String else {
            return true
        }
        return !replacedKeys.contains(key)
    }

    movie.metadata = existing + [
        quickTimeMetadata(
            contentIdentifierKey,
            value: identifier as NSString,
            dataType: "com.apple.metadata.datatype.UTF-8"
        ),
        quickTimeMetadata(
            autoLivePhotoKey,
            value: NSNumber(value: Int8(1)),
            dataType: "com.apple.metadata.datatype.int8"
        ),
        quickTimeMetadata(
            vitalityScoreKey,
            value: NSNumber(value: Float(1.0)),
            dataType: "com.apple.metadata.datatype.float32"
        ),
        quickTimeMetadata(
            vitalityVersionKey,
            value: NSNumber(value: Int64(4)),
            dataType: "com.apple.metadata.datatype.int64"
        ),
    ]

    try movie.writeHeader(
        to: outputURL,
        fileType: .mov,
        options: .addMovieHeaderToDestination
    )
}

func jpegIdentifier(_ url: URL) -> String? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [AnyHashable: Any],
          let maker = properties[kCGImagePropertyMakerAppleDictionary] as? [AnyHashable: Any] else {
        return nil
    }
    return maker["17"] as? String
}

func movieMetadataItem(_ asset: AVAsset, key: String) -> AVMetadataItem? {
    for item in asset.metadata(forFormat: .quickTimeMetadata) {
        if item.key as? String == key,
           item.keySpace?.rawValue == "mdta" {
            return item
        }
    }
    return nil
}

func metadataIdentifiers(_ asset: AVAsset) -> Set<String> {
    var identifiers = Set<String>()
    for track in asset.tracks(withMediaType: .metadata) {
        for raw in track.formatDescriptions {
            let description = raw as! CMFormatDescription
            guard let values = CMMetadataFormatDescriptionGetIdentifiers(description) else {
                continue
            }
            for case let identifier as AVMetadataIdentifier in values as NSArray {
                identifiers.insert(identifier.rawValue)
            }
        }
    }
    return identifiers
}

func metadataReferenceCount(_ asset: AVAsset) -> Int {
    guard let videoTrack = asset.tracks(withMediaType: .video).first else {
        return 0
    }
    return asset.tracks(withMediaType: .metadata).filter { metadataTrack in
        metadataTrack.associatedTracks(ofType: .metadataReferent).contains {
            $0.trackID == videoTrack.trackID
        }
    }.count
}

func verifyPair(photoURL: URL, movieURL: URL, expectedIdentifier: String) throws {
    try require(
        jpegIdentifier(photoURL) == expectedIdentifier,
        "Paired JPEG MakerApple[17] identifier verification failed."
    )

    let asset = AVURLAsset(
        url: movieURL,
        options: [AVURLAssetPreferPreciseDurationAndTimingKey: true]
    )
    try require(
        movieMetadataItem(asset, key: contentIdentifierKey)?.stringValue == expectedIdentifier,
        "Paired MOV content identifier verification failed."
    )
    try require(
        movieMetadataItem(asset, key: autoLivePhotoKey)?.numberValue?.intValue == 1,
        "Paired MOV Live Photo auto metadata verification failed."
    )
    try require(
        (movieMetadataItem(asset, key: vitalityScoreKey)?.numberValue?.doubleValue ?? -1) >= 0.5,
        "Paired MOV Live Photo vitality score verification failed."
    )
    try require(
        movieMetadataItem(asset, key: vitalityVersionKey) != nil,
        "Paired MOV Live Photo vitality version verification failed."
    )

    let identifiers = metadataIdentifiers(asset)
    let missing = requiredWallpaperIdentifiers.subtracting(identifiers)
    try require(
        missing.isEmpty,
        "Wallpaper metadata identifiers missing: \(missing.sorted().joined(separator: ", "))."
    )

    let referenceCount = metadataReferenceCount(asset)
    try require(
        referenceCount >= 2,
        "Prepared MOV lost metadata-to-video cdsc/tref associations."
    )

    let video = asset.tracks(withMediaType: .video).first
    let fps = video?.nominalFrameRate ?? 0
    let timeScale = video?.naturalTimeScale ?? 0
    print(
        "APPLE_WALLPAPER_STRUCTURE metadata=\(identifiers.sorted().joined(separator: "|")) " +
        "referenced_tracks=\(referenceCount) fps=\(String(format: "%.3f", fps)) timescale=\(timeScale)"
    )
}

func main() throws {
    let args = CommandLine.arguments
    guard args.count == 5 else {
        throw PairError.message(
            "Usage: apple_live_photo_pair.swift <input.jpg> <prepared.mov> <output.jpg> <output.mov>"
        )
    }

    let inputPhoto = URL(fileURLWithPath: args[1])
    let inputMovie = URL(fileURLWithPath: args[2])
    let outputPhoto = URL(fileURLWithPath: args[3])
    let outputMovie = URL(fileURLWithPath: args[4])
    let identifier = UUID().uuidString

    try pairJPEG(inputURL: inputPhoto, outputURL: outputPhoto, identifier: identifier)
    try stampPreparedMovie(inputURL: inputMovie, outputURL: outputMovie, identifier: identifier)
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
