# Fleet Canvas for iPhone

Fleet Canvas for iPhone is a native SwiftUI control surface for the Fleet Core
API. It uses the same dark, cyan-accented visual language as the Electron app,
with iPhone-native navigation, sheets, touch targets, Dynamic Type, Keychain
storage, Face ID/passcode confirmation, and QR enrollment.

The app never ships with mock fleet data or embedded credentials. Device,
job, Codex, approval, alert, and telemetry views are populated from the
configured live Fleet Core.

## Included controls

- Mission health and capacity dashboard
- Complete fleet list and device telemetry
- Wake, lock, sleep, restart, and shutdown
- Job creation, output, retry, and cancellation
- Codex session list, chat, live permission changes, approvals, interrupt, stop, and resume
- Alerts, notifications, and approval inbox
- QR or manual Fleet Core enrollment
- Authenticated WebSocket updates with foreground reconnection
- Keychain-backed scoped API credentials

## Generate and build

Requirements:

- Xcode 26 or newer
- XcodeGen 2.44.1 or newer
- iOS 18 or newer

```sh
cd apps/ios
xcodegen generate
xcodebuild \
  -project FleetCanvas.xcodeproj \
  -scheme FleetCanvas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test
```

The generated Xcode project is checked in for convenience, while
`project.yml` remains the source of truth.

## Connect securely

Use a least-privilege Fleet API token with:

```text
fleet:read
fleet:write
power:write
```

Enter the private Tailscale address for Fleet Core, or scan a Fleet pairing QR
code from inside the app. Credentials are stored with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.

Debug builds permit private `http://100.x` Core addresses for local
development. Release builds require HTTPS. Do not expose Fleet Core, NAS
administration, or device agents to the public internet.

## Live UI verification

The UI test reads its live test connection only from the test process
environment:

```sh
export FLEET_TEST_CORE_URL='https://fleet-core.example.ts.net'
export FLEET_TEST_TOKEN='a-scoped-test-token'
xcodebuild \
  -project FleetCanvas.xcodeproj \
  -scheme FleetCanvas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test
```

If those variables are absent, the live navigation test skips without using
fallback or sample data.

## Personal Team installations

Apple Personal Team provisioning permits only three development-signed apps
on a device at once, and profiles expire quickly. A paid Apple Developer
Program team and TestFlight are recommended for durable distribution.
