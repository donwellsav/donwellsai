#!/usr/bin/env python3
"""Run only against the disposable guest provisioned for Task 24; no host discovery."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tempfile
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--trial-root', type=pathlib.Path, required=True)
parser.add_argument('--host', required=True)
args = parser.parse_args()
root = args.trial_root.resolve()
assert args.host == '192.168.64.2', 'This receipt is scoped to the disposable NAT guest'
ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
       '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={root}/ssh/known_hosts',
       '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
       '-i', str(root / 'ssh/trial'), f'dwtrial@{args.host}']
checks = []


def run(command, expected=0, prefix='trial-v1 donwells-task24'):
    result = subprocess.run(ssh + [f'{prefix} {command}'], capture_output=True, text=True, timeout=30)
    assert result.returncode == expected, (command, result.returncode, result.stderr)
    return result.stdout.strip()


def until(operation, expected):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        status = run(f'status {operation}').splitlines()
        if status[0] == expected:
            return status
        time.sleep(.2)
    raise AssertionError((operation, expected, status))


hello = run('hello')
assert hello.splitlines()[0] == 'trial-v1 donwells-task24 /Users/dwtrial/donwells-trial-project'
checks.append('authenticated pinned host, explicit project and protocol negotiation')
run('hello', 65, 'trial-v2 donwells-task24')
run('hello', 65, 'trial-v1 different-project')
run('hello; id', 64)
run('artifact ../../etc/passwd', 64)
run('id', 64, '')
checks.append('wrong protocol, project, shell command and traversal denied')

with tempfile.TemporaryDirectory(prefix='donwells-remote-auth-') as temporary:
    temporary = pathlib.Path(temporary)
    other = temporary / 'identity'
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(other)], check=True)
    wrong_identity = list(ssh)
    wrong_identity[wrong_identity.index('-i') + 1] = str(other)
    result = subprocess.run(wrong_identity + ['trial-v1 donwells-task24 hello'], capture_output=True, timeout=10)
    assert result.returncode == 255 and b'Permission denied' in result.stderr
    key = other.with_suffix('.pub').read_text().split()
    wrong_hosts = temporary / 'known_hosts'
    wrong_hosts.write_text(f'{args.host} {key[0]} {key[1]}\n')
    wrong_host = [f'UserKnownHostsFile={wrong_hosts}' if item.startswith('UserKnownHostsFile=') else item for item in ssh]
    result = subprocess.run(wrong_host + ['trial-v1 donwells-task24 hello'], capture_output=True, timeout=10)
    assert result.returncode == 255 and b'HOST IDENTIFICATION HAS CHANGED' in result.stderr
checks.append('unpaired identity and changed host key denied')

revision = run('revision')
assert revision == hashlib.sha256((root / 'selected-project/revision.txt').read_bytes()).hexdigest()
run('resume')
operation = uuid.uuid4().hex
connection = subprocess.Popen(ssh + [f'trial-v1 donwells-task24 start {operation} {revision} 5'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    accepted = connection.stdout.readline().strip()
    assert accepted.startswith(f'accepted {operation} '), accepted
    first = until(operation, 'running')
    connection.terminate()
    connection.wait(timeout=5)
    observations = [run(f'status {operation}').splitlines() for _ in range(3)]
    final = until(operation, 'complete')
    assert all(row[1] == first[1] for row in observations + [final])
finally:
    if connection.poll() is None:
        connection.kill()
        connection.wait()
artifact = run(f'artifact {operation}') + '\n'
assert artifact == f'verified remote artifact {operation}\n'
assert run(f'start {operation} {revision} 5') == 'existing complete'
assert run(f'artifact {operation}') + '\n' == artifact
checks.append('disconnect during write, three reconnects, retained ownership and no duplicate replay')

run(f'start {uuid.uuid4().hex} {"0" * 64} 5', 73)
checks.append('source revision divergence rejected before write')
run('pause')
run(f'start {uuid.uuid4().hex} {revision} 5', 75)
run('resume')
stopped_operation = uuid.uuid4().hex
connection = subprocess.Popen(ssh + [f'trial-v1 donwells-task24 start {stopped_operation} {revision} 20'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    assert connection.stdout.readline().startswith('accepted ')
    until(stopped_operation, 'running')
    run(f'stop {stopped_operation}')
    until(stopped_operation, 'stopped')
    run(f'artifact {stopped_operation}', 75)
    assert run(f'status {operation}').splitlines()[0] == 'complete'
    connection.wait(timeout=5)
finally:
    if connection.poll() is None:
        connection.kill()
        connection.wait()
checks.append('pause refuses actions, resume works, stop affects only owned operation')

# Import is explicitly staged; existing local files are never replaced by this trial.
stage = root / 'returned-artifacts' / f'remote-{operation}'
stage.mkdir()
with (stage / 'artifact.txt').open('x') as output:
    output.write(artifact)
assert sorted(p.name for p in stage.iterdir()) == ['artifact.txt']
assert run('revision') == revision
checks.append('selected artifact staged separately; original source hash preserved')
receipt = {'profile': 'disposable forced-command SSH prototype, not production RPC',
           'host': args.host, 'hello': hello, 'checks': checks, 'operation': operation,
           'stoppedOperation': stopped_operation, 'sourceSha256': revision,
           'artifactSha256': hashlib.sha256(artifact.encode()).hexdigest(),
           'reconnectObservations': observations, 'finalOperation': final,
           'limitations': ['fixed disposable project and artifact schema',
                           'no production terminal or computer-control RPC',
                           'no in-flight external source mutation trial',
                           'staged import only; existing app project-kit importer tested separately']}
(root / 'remote-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
