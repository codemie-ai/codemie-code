// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "codemie-codenotch",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "codemie-codenotch", targets: ["codemie-codenotch"]),
        .library(name: "CodemieCodenotchCore", targets: ["CodemieCodenotchCore"]),
    ],
    targets: [
        .target(
            name: "CodemieCodenotchCore"
        ),
        .executableTarget(
            name: "codemie-codenotch",
            dependencies: ["CodemieCodenotchCore"],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "codemie-codenotchTests",
            dependencies: ["CodemieCodenotchCore"],
            swiftSettings: [
                // Command Line Tools (machines without Xcode.app) keep
                // libTestingMacros.dylib in a plugins/testing/ subdirectory
                // that SwiftPM does not scan, so swift-testing macros fail to
                // resolve there; Xcode toolchains ship it directly under
                // plugins/ and harmlessly ignore this extra search path.
                .unsafeFlags(["-plugin-path", "/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing"]),
            ]
        ),
    ]
)
