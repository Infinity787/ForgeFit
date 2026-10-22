#!/bin/bash
set -e
echo "📦 Syncing web assets..."
cp index.html www/index.html
ANDROID_HOME=~/Library/Android/sdk npx cap sync android 2>&1 | tail -3
echo "🔨 Building APK..."
cd android && JAVA_HOME=/Users/krishna/Library/Java/JavaVirtualMachines/jbr-21.0.11/Contents/Home ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug 2>&1 | tail -3
cd ..
cp android/app/build/outputs/apk/debug/app-debug.apk ./ForgeFit.apk
echo "📱 Installing to device..."
~/Library/Android/sdk/platform-tools/adb install -r ./ForgeFit.apk
echo "✅ Done! Data preserved."
