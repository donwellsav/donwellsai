"""Opt-in native candidate comparison; only acts on processes launched here."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument('--peekaboo', required=True)
parser.add_argument('--cua', required=True)
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='donwells-native-candidates-'))
report = {'root': str(root), 'requests': [], 'hashes': {}, 'passed': False}
owned = []
env = dict(os.environ, CUA_DRIVER_RS_TELEMETRY_ENABLED='false')


def command(argv):
    start = time.monotonic()
    result = subprocess.run(argv, capture_output=True, text=True, timeout=20, env=env)
    try:
        output = json.loads(result.stdout)
    except ValueError:
        output = result.stdout
    report['requests'].append({'argv': argv, 'seconds': time.monotonic() - start,
                               'exitCode': result.returncode, 'output': output, 'stderr': result.stderr})
    return output


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def wait_for(check):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError('Fixture readiness timed out')


try:
    for binary in [args.peekaboo, args.cua]:
        report['hashes'][binary] = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
    source = Path(__file__).resolve().parents[1] / 'fixtures/native-control.swift'
    binary = root / 'fixture'
    subprocess.run(['swiftc', str(source), '-o', str(binary)], check=True, capture_output=True)
    receipt = root / 'actions.json'
    target = subprocess.Popen([str(binary), str(receipt)])
    owned.append(target)
    time.sleep(1)
    peek = [args.peekaboo]
    report['peekabooPermissions'] = command(peek + ['permissions', 'status', '--json', '--no-remote'])
    snapshot = command(peek + ['see', '--pid', str(target.pid), '--window-title', 'Donwells Control Fixture A',
                               '--tree', '--no-screenshot', '--json', '--no-remote'])
    assert snapshot['success']
    window = snapshot['target_receipt']['window_id']
    element = next(e['id'] for e in snapshot['data']['ui_elements'] if e.get('title') == 'Record A')
    action = peek + ['action', 'AXPress', '--on', element, '--snapshot', snapshot['data']['snapshot_id'], '--json', '--no-remote']
    refused = command(action)
    assert refused['outcome']['mutation_dispatched'] is False
    assert not receipt.exists()
    assert command(action + ['--foreground'])['success']
    wait_for(receipt.exists)
    assert [x['target'] for x in json.loads(receipt.read_text())] == ['A']

    socket = root / 'driver.sock'
    log = open(root / 'driver.log', 'w')
    daemon = subprocess.Popen([args.cua, 'serve', '--embedded', '--socket', str(socket)], env=env, stdout=log, stderr=log)
    owned.append(daemon)
    wait_for(socket.exists)

    def cua(tool, parameters):
        return command([args.cua, 'call', tool, json.dumps(parameters), '--socket', str(socket)])

    report['cuaPermissions'] = cua('check_permissions', {})
    state = cua('get_window_state', {'pid': target.pid, 'window_id': window, 'include_screenshot': False, 'query': 'Recorded A'})
    token = next(e['element_token'] for e in state['elements'] if e.get('label') == 'Recorded A')
    sentinel = subprocess.Popen([str(binary), str(root / 'sentinel-actions.json')])
    owned.append(sentinel)
    time.sleep(1)
    result = cua('click', {'pid': target.pid, 'window_id': window, 'element_token': token, 'delivery_mode': 'background'})
    wait_for(lambda: len(json.loads(receipt.read_text())) == 2)
    actions = json.loads(receipt.read_text())
    assert actions[-1] == {'target': 'A', 'frontmostPid': str(sentinel.pid)}, actions
    assert not (root / 'sentinel-actions.json').exists()
    report['background'] = {'peekaboo': 'requires explicit foreground consent', 'cua': 'preserved sentinel foreground', 'actions': actions}

    second = command(peek + ['see', '--pid', str(target.pid), '--window-title', 'Donwells Control Fixture B',
                             '--tree', '--no-screenshot', '--json', '--no-remote'])
    second_window = second['target_receipt']['window_id']
    state_b = cua('get_window_state', {'pid': target.pid, 'window_id': second_window, 'include_screenshot': False, 'query': 'Record B'})
    token_b = next(e['element_token'] for e in state_b['elements'] if e.get('label') == 'Record B')
    cua('click', {'pid': target.pid, 'window_id': second_window, 'element_token': token_b, 'delivery_mode': 'background'})
    wait_for(lambda: len(json.loads(receipt.read_text())) == 3)
    assert json.loads(receipt.read_text())[-1] == {'target': 'B', 'frontmostPid': str(sentinel.pid)}
    element_b = next(e['id'] for e in second['data']['ui_elements'] if e.get('title') == 'Record B')
    assert command(peek + ['action', 'AXPress', '--on', element_b, '--snapshot', second['data']['snapshot_id'],
                           '--foreground', '--json', '--no-remote'])['success']
    wait_for(lambda: len(json.loads(receipt.read_text())) == 4)
    assert [a['target'] for a in json.loads(receipt.read_text())] == ['A', 'A', 'B', 'B']
    report['correctTargets'] = json.loads(receipt.read_text())

    stop(target)
    stale = cua('click', {'pid': target.pid, 'window_id': window, 'element_token': token, 'delivery_mode': 'background'})
    assert not (root / 'sentinel-actions.json').exists()
    assert 'error' in json.dumps(stale).lower() or 'refus' in json.dumps(stale).lower(), stale
    report['staleTarget'] = stale
    stale_peek = command(action + ['--foreground'])
    assert stale_peek['success'] is False
    assert not (root / 'sentinel-actions.json').exists()
    report['peekabooStaleTarget'] = stale_peek
    stop(daemon)
    # The embedded host owns this private endpoint; Cua intentionally refuses a stale socket.
    assert daemon.poll() is not None
    assert socket.is_socket()
    socket.unlink()
    report['restartPreparation'] = 'Reaped owned daemon before removing its private stale socket'
    restart_log = root / 'restart.log'
    daemon = subprocess.Popen([args.cua, 'serve', '--embedded', '--socket', str(socket)], env=env,
                              stdout=open(restart_log, 'w'), stderr=subprocess.STDOUT)
    owned.append(daemon)
    wait_for(lambda: 'listening on' in restart_log.read_text())
    sentinel_state = command(peek + ['see', '--pid', str(sentinel.pid), '--window-title', 'Donwells Control Fixture A',
                                     '--tree', '--no-screenshot', '--json', '--no-remote'])
    recovered = cua('get_window_state', {'pid': sentinel.pid, 'window_id': sentinel_state['target_receipt']['window_id'],
                                        'include_screenshot': False, 'query': 'Record A'})
    assert any(e.get('label') == 'Record A' for e in recovered['elements'])
    assert not (root / 'sentinel-actions.json').exists()
    report['serviceRestart'] = 'Fresh target observation works; no action replayed'
    report['passed'] = True
except Exception as error:
    report['error'] = str(error)
    raise
finally:
    for process in reversed(owned):
        stop(process)
    report['cleanup'] = [{'pid': p.pid, 'exitCode': p.poll()} for p in owned]
    with open(args.evidence, 'x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
