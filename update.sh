#!/bin/bash
# Builds the Android app, copies it to ./ForgeFit.apk and installs it on the
# phone connected over USB (keeps the app's data).
set -e
export ANDROID_HOME=~/Library/Android/sdk
echo "📦 Syncing web assets..."
npm run android:copy --silent
echo "🔨 Building APK..."
(cd android && JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew assembleDebug -q)
cp android/app/build/outputs/apk/debug/app-debug.apk ./ForgeFit.apk
echo "📱 Installing to device..."
"$ANDROID_HOME/platform-tools/adb" install -r ./ForgeFit.apk
echo "✅ Done! Data preserved."
