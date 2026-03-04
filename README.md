# Arcway Mac

macOS menu bar app (SwiftUI) that bundles Node.js and the relay server locally.

## Requirements

- macOS 13.0+
- Xcode 15+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — `brew install xcodegen`
- Node.js (bundled automatically via `make setup`)

## Setup & Build

```bash
# First time: bundle Node.js and generate Xcode project
make setup

# Build release binary
make build

# Create distributable DMG
make dmg
```

## Development

```bash
# Regenerate Xcode project after editing project.yml
make generate

# Then open in Xcode
open ClaudeRemote.xcodeproj
```
