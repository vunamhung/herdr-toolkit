#!/bin/sh
# One-time: a self-signed code-signing certificate "VNH Local" in the login keychain, so the gesture apps (HerdrPad, PadActions) keep
# their Accessibility grant across rebuilds. An ad hoc signature changes with every build, and macOS then forgets the grant; a
# signature by this certificate gives the apps a stable identity (identifier + certificate). install.sh --gestures signs with it
# when it is there. macOS asks for your password once, to trust the certificate for code signing.
set -eu
security find-identity -v -p codesigning | grep -q '"VNH Local"' && { echo 'VNH Local is already there'; exit 0; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/vnh.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = VNH Local
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
KC="$HOME/Library/Keychains/login.keychain-db"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/vnh.key" -out "$D/vnh.crt" -days 3650 -config "$D/vnh.cnf"
openssl pkcs12 -export -inkey "$D/vnh.key" -in "$D/vnh.crt" -out "$D/vnh.p12" -passout pass:vnh -name "VNH Local"
security import "$D/vnh.p12" -k "$KC" -P vnh -T /usr/bin/codesign
security add-trusted-cert -r trustRoot -p codeSign -k "$KC" "$D/vnh.crt"
security find-identity -v -p codesigning | grep 'VNH Local'
