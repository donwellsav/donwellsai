// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "DonwellsGhostty", platforms: [.macOS(.v13)],
    products: [.library(name: "DonwellsGhostty", type: .dynamic, targets: ["DonwellsGhostty"])],
    dependencies: [.package(path: ".vendor/libghostty-spm")],
    targets: [.target(name: "DonwellsGhostty", dependencies: [.product(name: "GhosttyTerminal", package: "libghostty-spm")])]
)
