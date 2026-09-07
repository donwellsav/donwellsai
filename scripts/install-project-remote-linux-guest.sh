#!/bin/sh
# Prepare a new dedicated Linux arm64 SSH endpoint. This does not start sshd.
set -eu
umask 077
[ "$#" = 3 ] || { echo 'Usage: sudo install-project-remote-linux-guest.sh /bundle /client.pub EXPECTED_MACHINE_ID_SHA256' >&2; exit 2; }
bundle=$1
public_key=$2
expected_machine=$3
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = aarch64 ] || { echo 'Requires administrator inside a Linux arm64 guest' >&2; exit 1; }
actual_machine=$(sha256sum /etc/machine-id | cut -d ' ' -f 1)
[ -n "$expected_machine" ] && [ "$actual_machine" = "$expected_machine" ] || { echo 'Guest identity does not match; no changes made' >&2; exit 1; }
case "$bundle:$public_key" in /*:/*) ;; *) exit 1;; esac
[ -f "$bundle/deployment-manifest.json" ] && [ -f "$public_key" ] || exit 1
id dwtrial >/dev/null 2>&1 || { echo 'Dedicated dwtrial account is required' >&2; exit 1; }
[ "$(passwd -S dwtrial | awk '{print $2}')" != L ] || { echo 'Dedicated dwtrial account is locked; enable public-key login before installation' >&2; exit 1; }
command -v sshd >/dev/null 2>&1 || { echo 'OpenSSH server is required' >&2; exit 1; }
prefix=/usr/local/lib/donwells-plan24
mapping_dir=/etc/donwells-plan24
workspace=/home/dwtrial/donwells-plan24-project
owner_state=/home/dwtrial/.donwells-plan24-owner
config=/etc/ssh/sshd_config.d/00-donwells-plan24.conf
[ -d /etc/ssh/sshd_config.d ] || { echo 'sshd_config.d with an active Include is required' >&2; exit 1; }
for target in "$prefix" "$mapping_dir" "$workspace" "$owner_state" "$config"; do [ ! -e "$target" ] || { echo "Destination already exists: $target; refusing replacement" >&2; exit 1; }; done
"$bundle/bin/node" - "$bundle" "$public_key" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [root,key]=process.argv.slice(2),manifest=JSON.parse(fs.readFileSync(path.join(root,'deployment-manifest.json')));if(manifest.runtime?.platform!=='linux'||manifest.runtime?.arch!=='arm64'||!/^v24\./.test(manifest.runtime?.version)||manifest.nodePty?.nativePath!=='build/Release/pty.node')throw Error('Expected a qualified Linux arm64 bundle');for(const file of manifest.files){if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').includes('..'))throw Error('Invalid manifest path');const p=path.join(root,file.path),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==file.bytes||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==file.sha256)throw Error('Bundle file failed verification: '+file.path)}if(!/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]*)?\n?$/.test(fs.readFileSync(key,'utf8')))throw Error('Expected one plain Ed25519 public key')
JS
install -d -o root -g root -m 755 /usr/local/lib "$mapping_dir"
cp -a "$bundle" "$prefix"
chown -R root:root "$prefix"
chmod -R a+rX,go-w "$prefix"
su -s /bin/sh dwtrial -c "cd '$prefix' && ./bin/node -e \"require('node-pty')\""
install -d -o dwtrial -g "$(id -gn dwtrial)" -m 700 "$workspace" "$owner_state"
"$prefix/bin/node" - "$mapping_dir" "$public_key" <<'JS'
const fs=require('fs'),path=require('path');const [dir,key]=process.argv.slice(2),entry='/usr/local/lib/donwells-plan24/bin/node /usr/local/lib/donwells-plan24/out/main/project-remote-entry.js --mapping /etc/donwells-plan24/project.json';fs.writeFileSync(path.join(dir,'authorized_keys'),'restrict,port-forwarding,command="'+entry+'" '+fs.readFileSync(key,'utf8').trim()+'\n',{mode:0o644,flag:'wx'});fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify({version:1,environmentId:'plan24-linux',generation:1,projectId:'plan24-linux-project',root:'/home/dwtrial/donwells-plan24-project',stateDirectory:'/home/dwtrial/.donwells-plan24-owner'},null,2)+'\n',{mode:0o644,flag:'wx'});
JS
chmod 644 "$mapping_dir/authorized_keys" "$mapping_dir/project.json"
cat > "$config" <<'CONFIG'
Match User dwtrial
  AuthorizedKeysFile /etc/donwells-plan24/authorized_keys
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  # OpenSSH gates StreamLocal forwarding on this flag; PermitOpen/PermitListen retain the TCP denial.
  AllowTcpForwarding remote
  AllowStreamLocalForwarding remote
  PermitOpen none
  PermitListen none
  AllowAgentForwarding no
  X11Forwarding no
  PermitTunnel no
  PermitTTY no
Match all
CONFIG
chown root:root "$config"
chmod 644 "$config"
sshd -t
sshd -T -C user=dwtrial,host=localhost,addr=127.0.0.1 | awk '/^(authorizedkeysfile|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|allowtcpforwarding|allowstreamlocalforwarding|permitopen|permitlisten|allowagentforwarding|x11forwarding|permittunnel|permittty) /'
echo 'Prepared only. Confirm effective SSH policy before starting sshd.'
echo 'Publish container SSH only on 127.0.0.1; verify the host key outside SSH before pairing.'
