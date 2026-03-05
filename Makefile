.PHONY: bundle generate build dmg

bundle:
	bash Scripts/bundle-node.sh

generate:
	xcodegen generate

setup: bundle generate

build:
	xcodebuild \
		-project ClaudeRemote.xcodeproj \
		-scheme ClaudeRemote \
		-configuration Release \
		-derivedDataPath build \
		build

dmg: build
	create-dmg \
		--volname "Claude Remote" \
		--window-pos 200 120 \
		--window-size 600 400 \
		--icon-size 100 \
		--icon "Arcway.app" 150 185 \
		--hide-extension "Arcway.app" \
		--app-drop-link 450 185 \
		"Arcway.dmg" \
		"build/Build/Products/Release/Arcway.app"
