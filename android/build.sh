#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-arm64
export PATH="$JAVA_HOME/bin:$PATH"

SDK="/usr/lib/android-sdk"
AJ="$SDK/platforms/android-23/android.jar"
BT="$SDK/build-tools/29.0.3"
OUT="build"
APK_NAME="CTViewer-2.0.0.apk"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/assets/css" "$OUT/assets/js" "$OUT/assets/vendor" "$OUT/assets/assets/models"

echo "[1/6] staging web assets"
cp ../index.html "$OUT/assets/index.html"
cp ../sw.js "$OUT/assets/sw.js"
cp -r ../css/. "$OUT/assets/css/"
cp -r ../js/. "$OUT/assets/js/"
cp -r ../vendor/. "$OUT/assets/vendor/"
cp -r ../assets/models/. "$OUT/assets/assets/models/"

echo "[2/6] compile Android resources"
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/app-unsigned.apk" \
  -I "$AJ" \
  --manifest AndroidManifest.xml \
  -R "$OUT/res.zip" \
  -A "$OUT/assets" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  --min-sdk-version 24 \
  --target-sdk-version 29

echo "[3/6] compile Java"
javac -encoding UTF-8 -source 8 -target 8 \
  -classpath "$AJ" \
  -d "$OUT/classes" \
  "$OUT/gen/com/dsh/ctviewer/R.java" \
  src/com/dsh/ctviewer/MainActivity.java 2>&1 | sed '/bootstrap class path/d;/source value 8/d;/target value 8/d;/^1 warning/d' || true

echo "[4/6] dex"
java -cp lib/d8.jar com.android.tools.r8.D8 --release --min-api 24 --lib "$AJ" --output "$OUT/dex" "$OUT"/classes/com/dsh/ctviewer/*.class

echo "[5/6] package + align"
python3 - "$OUT/app-unsigned.apk" "$OUT/dex/classes.dex" <<'PY'
import zipfile, sys, os
apk, dex = sys.argv[1], sys.argv[2]
tmp = apk + '.tmp'
with zipfile.ZipFile(apk) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        if item.filename == 'classes.dex':
            continue
        zout.writestr(item, zin.read(item.filename))
    zout.write(dex, 'classes.dex')
os.replace(tmp, apk)
PY
"$BT/zipalign" -f 4 "$OUT/app-unsigned.apk" "$OUT/app-aligned.apk"

echo "[6/6] sign + verify"
mkdir -p keystore
if [ ! -f keystore/ctviewer.jks ]; then
  keytool -genkeypair -v \
    -keystore keystore/ctviewer.jks \
    -alias ctviewer \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass ctviewer -keypass ctviewer \
    -dname "CN=CTViewer, OU=DSH, O=DSH, L=CN, ST=CN, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign \
  --ks keystore/ctviewer.jks \
  --ks-key-alias ctviewer \
  --ks-pass pass:ctviewer \
  --key-pass pass:ctviewer \
  --out "$OUT/$APK_NAME" \
  "$OUT/app-aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/$APK_NAME" | head -8
echo
echo "OK: $OUT/$APK_NAME"
ls -lh "$OUT/$APK_NAME"
