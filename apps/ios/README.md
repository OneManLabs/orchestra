# Orchestra for iPhone

Orchestra for iPhone is a native SwiftUI client for Orchestra Core. It uses iOS navigation, sheets, Dynamic Type, Keychain, device authentication, and QR enrollment.

The application does not contain sample fleet data or credentials. It gets device, job, Codex, approval, alert, and telemetry data from the configured Core.

## Functions

- Show fleet status and capacity.
- Show devices and telemetry.
- Wake, lock, sleep, restart, or shut down a device.
- Start, retry, or cancel a job.
- Show job output.
- Control Codex sessions and approvals.
- Show alerts and notifications.
- Enroll with a QR code or manual data.
- Reconnect the WebSocket when the application becomes active.
- Keep API credentials in Keychain.

## Build and test

Requirements:

- Xcode 26 or a newer version
- XcodeGen 2.44.1 or a newer version
- iOS 18 or a newer version

Run these commands:

```sh
cd apps/ios
xcodegen generate
xcodebuild \
  -project FleetCanvas.xcodeproj \
  -scheme FleetCanvas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test
```

`project.yml` is the source file for the Xcode project. The repository also contains the generated project.

## Connect to Core

Use an API token with only the necessary scopes. These scopes are a typical set:

```text
fleet:read
fleet:write
power:write
```

Enter the private Core address. You can also scan an Orchestra enrollment QR code.

The application stores credentials with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.

Debug builds permit private `http://100.x` addresses. Release builds require HTTPS.

Do not expose Core, NAS administration, or Agents to the public internet.

## Live UI test

Set the test connection in the test-process environment:

```sh
export FLEET_TEST_CORE_URL='https://fleet-core.example.ts.net'
export FLEET_TEST_TOKEN='a-scoped-test-token'
xcodebuild \
  -project FleetCanvas.xcodeproj \
  -scheme FleetCanvas \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  test
```

The live test does not use fallback data. It skips when these variables are not present.

## Apple Personal Team limit

Personal Team provisioning permits three development-signed applications on one device. The profiles also have a short life.

Use a paid Apple Developer Program team and TestFlight for long-term distribution.
