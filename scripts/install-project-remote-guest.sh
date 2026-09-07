#!/bin/bash
# Run manually in the NEW clone only, after verifying its regenerated MAC on the host.
set -euo pipefail
if [[ $# != 3 ]]; then echo 'Usage: sudo install-project-remote-guest.sh /mounted/bundle /mounted/client.pub EXPECTED_NEW_CLONE_MAC' >&2; exit 2; fi
bundle=$1
public_key=$2
expected_mac=$3
[[ $(/usr/bin/id -u) == 0 && $(/usr/bin/uname -s) == Darwin && $(/usr/bin/uname -m) == arm64 ]] || { echo 'Requires administrator inside the new macOS arm64 clone' >&2; exit 1; }
actual_mac=$(/sbin/ifconfig en0 | /usr/bin/awk '/ether / {print $2; exit}')
[[ -n "$expected_mac" && "$actual_mac" == "$expected_mac" ]] || { echo 'Guest MAC does not match the newly cloned machine; no changes made' >&2; exit 1; }
[[ "$bundle" == /* && "$public_key" == /* && -f "$bundle/deployment-manifest.json" && -f "$public_key" ]] || exit 1
/usr/bin/id dwtrial >/dev/null
prefix=/usr/local/lib/donwells-plan24
mapping_dir=/private/etc/donwells-plan24
workspace=/Users/dwtrial/donwells-plan24-project
owner_state=/Users/dwtrial/.donwells-plan24-owner
config=/etc/ssh/sshd_config.d/00-donwells-plan24.conf
for target in "$prefix" "$mapping_dir" "$workspace" "$owner_state" "$config"; do [[ ! -e "$target" ]] || { echo "Destination already exists: $target; refusing replacement" >&2; exit 1; }; done
"$bundle/bin/node" - "$bundle" "$public_key" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');const [root,key]=process.argv.slice(2);const manifest=JSON.parse(fs.readFileSync(path.join(root,'deployment-manifest.json')));for(const file of manifest.files){if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.split('/').includes('..'))throw Error('Invalid manifest path');const p=path.join(root,file.path),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==file.bytes||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==file.sha256)throw Error('Bundle file failed verification: '+file.path)}if(!/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]*)?\n?$/.test(fs.readFileSync(key,'utf8')))throw Error('Expected one plain Ed25519 public key')
JS
/usr/bin/install -d -o root -g wheel -m 755 /usr/local/lib "$mapping_dir"
/usr/bin/ditto "$bundle" "$prefix"
/usr/sbin/chown -R root:wheel "$prefix"
/bin/chmod -R a+rX,go-w "$prefix"
/usr/bin/install -d -o dwtrial -g staff -m 700 "$workspace" "$owner_state"
"$prefix/bin/node" - "$mapping_dir" "$public_key" <<'JS'
const fs=require('fs'),path=require('path');const [dir,key]=process.argv.slice(2);const entry='/usr/local/lib/donwells-plan24/bin/node /usr/local/lib/donwells-plan24/out/main/project-remote-entry.js --mapping /private/etc/donwells-plan24/project.json';fs.writeFileSync(path.join(dir,'authorized_keys'),'restrict,port-forwarding,command="'+entry+'" '+fs.readFileSync(key,'utf8').trim()+'\n',{mode:0o644,flag:'wx'});fs.writeFileSync(path.join(dir,'project.json'),JSON.stringify({version:1,environmentId:'plan24-guest',generation:1,projectId:'plan24-project',root:'/Users/dwtrial/donwells-plan24-project',stateDirectory:'/Users/dwtrial/.donwells-plan24-owner'},null,2)+'\n',{mode:0o644,flag:'wx'});
JS
/bin/chmod 644 "$mapping_dir/authorized_keys" "$mapping_dir/project.json"
/bin/cat > "$config" <<'CONFIG'
Match User dwtrial
  AuthorizedKeysFile /private/etc/donwells-plan24/authorized_keys
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
/usr/sbin/chown root:wheel "$config"
/bin/chmod 644 "$config"
/usr/sbin/sshd -t
/usr/sbin/sshd -T -C user=dwtrial,host=localhost,addr=127.0.0.1 | /usr/bin/awk '/^(authorizedkeysfile|authenticationmethods|passwordauthentication|kbdinteractiveauthentication|allowtcpforwarding|allowstreamlocalforwarding|allowagentforwarding|x11forwarding|permittunnel|permittty) /'
echo 'Prepared only. Confirm effective SSH policy above before enabling/using the SSH service.'
echo 'Host public key must be verified through the selected return mount, not network discovery.'
echo 'OpenCode is not installed by this script; pair an administrator-owned executable separately for agent.start.'
