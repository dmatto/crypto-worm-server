# Crypto Worm Wars apps

Installable apps that open the live game at https://play.cryptoworm.io in their own
window. Every game deploy reaches the apps at once; the apps only need rebuilding when
this folder changes.

| Platform | Folder | Output | Tag in game (`?src=`) |
|---|---|---|---|
| Android | `android/` (plain WebView, Java) | `.apk` | `android` |
| Windows | `desktop/` (Electron) | NSIS `.exe` installer | `windows` |
| Mac | `desktop/` (Electron) | `.dmg` (arm64 + x64) | `mac` |
| Linux | `desktop/` (Electron) | `.AppImage` | `linux` |

## Building

`.github/workflows/apps.yml` builds everything on GitHub Actions whenever `apps/` changes
(or by hand: Actions, "Build apps", Run workflow) and attaches the files to a
pre-release named `apps-v1.0.<run>`. Nothing is uploaded to any store.

Behaviour in both shells: game pages stay inside the app; every other link (Telegram, X,
wallet apps, Stars payments) opens in the system browser or the app that handles it.
If the connection drops, a "No connection / Try again" page shows.

## Signing

- **Android**: CI signs with the key in the `ANDROID_KEYSTORE_B64` and
  `ANDROID_KEYSTORE_PASSWORD` repo secrets (alias `cworm`), so each new APK installs over the
  last one. Without those secrets it signs with a throwaway key and testers must uninstall
  the old APK first. Google Play must use a
  separate upload key kept out of the repo, with Play App Signing.
- **Windows**: unsigned. SmartScreen warns until we buy a code-signing certificate.
- **Mac**: ad-hoc signed (`desktop/adhoc-sign.js`). macOS asks for "Open Anyway" in
  System Settings, Privacy & Security. Removing that needs an Apple Developer account
  ($99/year), Developer ID signing and notarization.

## Stores

These are wrappers around the website. Apple rejects that (guideline 4.2), and Apple also
bans unlocking content with crypto, so an App Store version needs a bundled build with
`window.CWW_STORE_BUILD = true` (hides wallet, holder and prize features). Google Play
accepts a wrapper but needs the Financial features declaration and, for a personal
developer account, a 14-day closed test with 12 testers.
