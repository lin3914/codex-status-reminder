// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CodexCompanionCore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "CodexCompanionCore", targets: ["CodexCompanionCore"]),
    ],
    targets: [
        .target(
            name: "CodexCompanionCore",
            path: "Sources/CodexCompanion",
            exclude: [
                "AppDelegate.swift",
                "LegacyWebRenderer.swift",
                "Views.swift",
                "WindowController.swift",
                "main.swift",
            ]
        ),
    ]
)
