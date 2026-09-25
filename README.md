# Rider's Black Box

A crash-detection and post-fall assistance app for two-wheeler riders. It detects a hard fall using the phone's motion sensors, asks the rider **"Are you OK?"**, and if they don't respond, sends their location to their emergency contacts. A quick injury check-in then routes them to the right next step: **first aid**, the **nearest hospital**, or an **emergency call**.

Built with Expo (React Native + TypeScript). Runs on Android and iOS; Android first.

> First-aid guidance and hospital routing only. The app never diagnoses injuries.

## Features (MVP)

| Flow | What it does |
|---|---|
| **Ride** | Start/End ride, live speed, distance, route trail, hard-braking detection. Saved to history. |
| **Crash detection** | Impact → stillness → orientation-change detector at 50 Hz (accelerometer + gyroscope). Adjustable sensitivity. |
| **"Are you OK?"** | Full-screen alert, vibration alarm, 20/30/45 s countdown, a huge **I'm Fine** button and an **I Need Help** button. |
| **No response** | Alerts all emergency contacts with a Google Maps link, time, severity and optional medical info, then opens the injury check-in. |
| **Injury check-in** | Front/back body map, multi-select, 🟢 minor / 🟡 moderate / 🔴 severe per area, optional notes. |
| **Outcome routing** | Minor → first-aid card + escalation signs. Moderate → nearby hospitals & clinics (OpenStreetMap) with Directions/Call. Severe → one-tap call to **112**, address to read to the operator, SEVERE alert to contacts. |
| **History** | Rides with route, stats and hard brakes; timestamped incident log (crash alerts + check-ins) for insurance claims. |
| **Contacts & profile** | Up to 5 emergency contacts, medical info card (blood group, allergies, conditions), alert preview. |
| **Settings** | Sensitivity, countdown, live-location follow-ups, emergency number, permission status, delete all data. |

All data is stored **locally on the phone** (AsyncStorage), so the app works with no signal on highways.

## Background mode (Android build)

In the installed Android app, a ride keeps going while you use **Google Maps as your navigation** or the screen is off:

- A **foreground service** (`modules/ride-monitor`, Kotlin) runs GPS logging, hard-brake detection and the crash detector (a Kotlin port of `src/lib/crash-detector.ts`), with a persistent "Ride in progress" notification and a partial wake lock.
- On a crash it raises an **alarm notification** with a live countdown, an **I'M FINE** action, and a **full-screen "Are you OK?" screen over the lock screen** or over Google Maps.
- **If nobody responds** (rider unconscious or can't reach the phone), `EmergencyResponder` takes over, all from the background / lock screen:
  - **texts every emergency contact from the SIM** with a Google Maps link, time and medical info; texts that fail (no signal) are **retried every minute** for 15 min
  - **follow-up location texts** every 3 min for 15 min
  - **phones the contacts one by one on speakerphone** (next contact if a call ends within 25 s or never connects; a second round after 2 min if nobody picked up)
  - a **loud siren** (alarm stream, max volume, pauses during calls) and a **bystander screen over the lock screen**: rider name, medical info, one-tap Call 112 and call-contact buttons
  - Android doesn't let ordinary apps dial 112 by themselves, so "Call 112" opens the dialer with 112 filled in
- **Demo (simulated) crashes send nothing and call nobody**: only the bystander screen (marked TEST) and a 15 s siren.
- Settings → **Background protection** checks notifications, lock-screen alerts, unrestricted battery (important on Motorola/Xiaomi/Samsung) and SMS permission.

Expo Go and iOS fall back to the foreground-only JS engine automatically.

### Build and install locally (Android)

Requires JDK 17 and the Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006):

```bash
brew install openjdk@17 && brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=~/Library/Android/sdk
sdkmanager --sdk_root=$ANDROID_HOME "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1"
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/release/app-release.apk
```

The release APK is self-contained (JS bundled), so it works away from your computer. It's signed with the debug keystore, which is fine for sideloading but not for the Play Store.

## Run it in Expo Go (quick preview)

1. Install **Expo Go** from the Play Store (Android) or App Store (iOS).
2. On your computer:
   ```bash
   npm install
   npx expo start
   ```
3. Scan the QR code with Expo Go (Android) or the Camera app (iOS). Phone and computer must be on the same Wi-Fi.
   - **Over USB (Android):** enable *Developer options → USB debugging*, plug in, then press `a` in the Expo terminal. If Wi-Fi is blocked, run `npx expo start --localhost` after `adb reverse tcp:8081 tcp:8081`.
4. Onboarding asks for your name and contacts. Start a ride, then tap **Simulate a crash (demo)** to see the full flow without falling off anything.

### Standalone APK (optional)

```bash
npx eas-cli@latest build -p android --profile preview
```
This needs a free Expo account. EAS builds the APK in the cloud, so you don't need Android Studio.

## Automatic SMS alerts (optional relay)

Expo Go can only *open* the SMS app pre-filled. That's fine when the rider taps **I Need Help**, but an unresponsive rider can't tap Send. The fix is the tiny relay in [`relay/server.mjs`](relay/server.mjs), which sends the SMS through Twilio:

```bash
TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1... RELAY_KEY=secret node relay/server.mjs
```

Then copy `.env.example` to `.env.local`, point `EXPO_PUBLIC_ALERT_RELAY_URL` at the relay, and restart `npx expo start`. With the relay:
- Alerts go out with no tap needed.
- Live-location follow-ups are sent every 2 minutes for 10 minutes.
- If the relay is unreachable, the app falls back to the SMS app.

## How crash detection works

[`src/lib/crash-detector.ts`](src/lib/crash-detector.ts) is pure TypeScript, a state machine over accelerometer samples:

1. **Impact:** acceleration magnitude ≥ threshold (2.5 / 3.5 / 5 g for high / medium / low sensitivity).
2. **Settle:** the tumble in the first 1 s after impact is ignored.
3. **Stillness:** for the next 2.5–3 s, low variance in |a| (≈1 g) and low rotation rate from the gyroscope.
4. **Orientation change:** the gravity vector after the fall differs from the one before by ≥ 30–50°. A very hard impact (≥ 2× threshold) skips this check.

If the phone starts moving normally again, the event is logged as a **bump** (pothole, dropped phone) and no alert fires. Run the synthetic checks with:

```bash
npm run test:detector
```

The detector has a small push-sample interface, so an on-device ML model can replace it later without touching the rest of the app.

## Project layout

```
src/
  app/                 Expo Router screens
    (tabs)/            Home, History, Contacts, Settings
    active-ride.tsx    Live ride + monitoring
    crash-alert.tsx    "Are you OK?" countdown
    checkin.tsx        Body map + severity
    outcome/           first-aid, hospitals, emergency
    ride/[id].tsx      Ride detail
    onboarding.tsx
  components/          UI kit, body map, route trail, contacts editor
  lib/
    crash-detector.ts  Fall detection algorithm
    ride-session.ts    GPS + sensors + hard-brake detection (singleton)
    alerts.ts          Alert message template + relay/SMS dispatch
    hospitals.ts       Overpass (OpenStreetMap) hospital lookup
    injury.ts          Body parts, severity routing, first-aid content
    store.ts           Local-first persisted store
modules/ride-monitor/  Native Android foreground service: GPS, crash detector, countdown, SIM SMS, lock-screen alert
relay/server.mjs       Optional Twilio SMS relay
scripts/               Detector simulation checks
```

## Known limitations

- **Expo Go / iOS:** foreground only (keep the app open). Background mode needs the Android build above.
- **Auto SMS from the SIM** uses `SEND_SMS`, which Google Play restricts. For a Play Store release, switch no-response alerts to the Twilio relay.
- Some Android skins kill background apps aggressively. Set battery to "Unrestricted" (Settings → Background protection).
- Hospital data comes from OpenStreetMap: good coverage in Indian cities, patchier in rural areas. A Google Maps search fallback is always available.

## Roadmap (v2)

ML-based crash detection · iOS background mode · live-tracking link · backend sync · insurance/fleet integrations · helmet/wearable sensors · community ride features.
