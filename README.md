# Android USB Runner

One click in VS Code builds your Gradle Android app and runs it on a physical USB-connected phone. For local Windows 10/11 workspaces, using your project's Gradle Wrapper and installed Android SDK. No emulator or wireless pairing is involved.

## Use

1. Install the extension from the `.vsix`: in VS Code, run **Extensions: Install from VSIX...** and select the package.
2. Open your Android project's folder in VS Code. A parent folder or multi-root workspace also works; the extension searches for `gradlew.bat`.
3. Connect your Android phone with a USB **data** cable.
4. Enable **Developer options → USB debugging** on the phone.
5. Unlock the phone and accept its **Allow USB debugging?** authorization prompt.
6. Click **▶ Android USB** in the status bar.
7. Your app builds, installs/updates with `-r`, and launches automatically.

Install Android Studio / the Android SDK with **Platform-Tools** and **Build Tools** first. Windows may also require your manufacturer's **OEM ADB USB driver**. Open the project in a trusted, local Windows VS Code window, rather than WSL, SSH, a container, or a browser. The first Gradle build may download the wrapper distribution and dependencies and take several minutes.

One ready USB phone and one application module are selected automatically. If there are several phones, projects, or modules, select one when prompted. Choices are remembered for the workspace and revalidated on each run. A disconnected phone is never silently replaced during a deployment. Emulators and TCP/mDNS wireless ADB serials are filtered out.

## Commands

| Command Palette command | Purpose |
| --- | --- |
| Android USB: Build, Install & Run | Same as the status bar button |
| Android USB: Select Device | Change the remembered USB phone |
| Android USB: Select Android Project | Change the remembered Gradle project |
| Android USB: Select App Module | Change the project's application module |
| Android USB: Show Output | Open build, install, and launch logs |

Deployment shows cancellable progress. A second click cannot start a concurrent deployment. Cancelling stops the active command; it does not roll back an installation that already completed.

## Optional settings

Normal Android Studio installations should work without configuration. Settings can be scoped to a workspace/folder; Windows `%ENVIRONMENT_VARIABLES%` work in paths. Use absolute paths.

| Setting | Default | Purpose |
| --- | --- | --- |
| `androidUsbRunner.adbPath` | empty | Explicit path to `adb.exe` |
| `androidUsbRunner.androidSdkPath` | empty | Explicit SDK directory with `platform-tools` and `build-tools` |
| `androidUsbRunner.javaHome` | empty | Explicit JDK/JBR home containing `bin/java.exe` |
| `androidUsbRunner.gradleTask` | `assembleDebug` | A single module assemble task, e.g. `assembleDemoDebug` |

ADB discovery checks explicit `adbPath`, then an explicit `androidSdkPath` if provided. Otherwise it checks `ANDROID_SDK_ROOT`, `ANDROID_HOME`, `%LOCALAPPDATA%\Android\Sdk`, then PATH. The project's `local.properties` is an additional fallback. `adb` need not be globally available. AAPT2 is taken from the newest installed Build Tools containing `aapt2.exe` in the selected SDK (with other discovered SDKs as fallbacks).

Gradle inherits VS Code's environment. A valid `JAVA_HOME` is kept; otherwise Java on PATH is tried, then `C:\Program Files\Android\Android Studio\jbr`. An explicit `javaHome` overrides Java only for this extension's build process. Choose a Java version compatible with your project's Gradle and Android Gradle Plugin. No machine-wide settings or project files are changed.

The wrapper is invoked through Windows `cmd.exe` using its **absolute path** and the **directory containing it** as `cwd`. Paths with spaces are supported. Only one validated Gradle task is accepted, rather than shell flags or command strings. A qualified task such as `:mobile:assembleDemoDebug` must refer to the selected module.

## Modules, variants, and APKs

- Detects `com.android.application` in Groovy/Kotlin build files, including standard `libs.plugins` aliases from `gradle/libs.versions.toml`. Honors ordinary `include(...)` and `project(...).projectDir = file(...)` mappings. Defaults to `app` when static detection is inconclusive. For convention plugins or dynamically generated Gradle settings, you may need to select the module explicitly; arbitrary Gradle code cannot be fully interpreted statically.
- Reads APK output metadata and filenames under the selected module's `build/outputs/apk`. It prefers outputs updated by the completed build and supports unchanged `UP-TO-DATE` outputs. Test APKs and unrelated variants are excluded.
- For flavor projects, use `assembleDemoDebug` to build just one variant; if `assembleDebug` produces multiple variants, select one once.
- Inspects the actual APK with `aapt2 dump badging` for its real application ID (including `.debug` suffixes) and launcher activity. Source folder names are not used to guess the ID.
- Selects compatible standalone ABI APKs, preferring a universal APK when available. Actual base/split sets with matching package/version are installed with `install-multiple -r`. Ambiguous standalone outputs get a remembered APK picker. Advanced custom output locations and bundle-only/dynamic-feature delivery workflows are outside this extension's scope.
- Launches an explicit component when available, then tries Android launcher resolution and package-based `monkey` fallback. All device-specific commands include `adb -s <serial>`.

## Troubleshooting

Every failure offers **Show Output**. The **Android USB Runner** channel contains the commands, working directory, stdout/stderr, and exit codes.

- **No phone:** use a data cable, enable USB debugging, and install the OEM ADB driver if needed. Verify the phone appears in `adb devices -l`.
- **Unauthorized:** unlock the phone and accept the USB debugging prompt, then click again.
- **Offline:** unlock and reconnect the phone, and check USB debugging.
- **Wrapper not found:** open the Android source folder or its parent. `.git`, `.gradle`, `build`, and `node_modules` are not searched. The project must include its Gradle Wrapper files.
- **Build failed:** inspect the Gradle error in Output. Installation stops immediately. Correct Java/SDK/dependency issues in the project and retry.
- **No APK:** confirm the chosen module uses the Android application plugin and the configured assemble task produces an APK under `build/outputs/apk`.
- **Signing mismatch/version downgrade:** use the original signing key or increase the versionCode. The extension does not automatically uninstall apps or erase their data.
- **Installed but cannot launch:** ensure the selected variant has a launchable `MAIN`/`LAUNCHER` activity.

## Develop and package

Use Node.js 22.12 or newer and npm. In PowerShell, `npm.cmd` avoids systems where script policy blocks `npm.ps1`.

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd test
npm.cmd run test:host
npm.cmd run package
```

`npm run package` runs `@vscode/vsce` and produces `android-usb-runner-1.0.3.vsix`. There are no runtime npm dependencies. The publisher name is a local packaging identifier; change it to your own registered publisher before publishing to the Marketplace.

To debug, open this repository and press **F5** using **Run Android USB Runner**. The included launch configuration compiles TypeScript and opens an Extension Development Host. Open your Android project in that new window, connect your phone, and click the button.

`npm test` covers discovery, USB filtering, Java/SDK precedence, output/variant selection, AAPT2 parsing, install/launch fallbacks, cancellation, and real Windows wrapper quoting using temporary fixtures. `npm run test:host` checks activation, all command IDs, the complete deployment flow, duplicate-click protection, and build/install failure stops using simulated native Android tools in an isolated Extension Development Host. It uses the Windows .NET Framework compiler to build the fixtures. Set `VSCODE_EXECUTABLE_PATH` to a local `Code.exe` to use that installation; otherwise the test runner downloads VS Code. Hardware deployment requires a real Android project and an authorized USB phone.

Implementation references: [VS Code extension manifest](https://code.visualstudio.com/api/references/extension-manifest), [extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension), [ADB](https://developer.android.com/tools/adb), [AAPT2](https://developer.android.com/tools/aapt2), and [Windows cmd quoting](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd).
