#!/usr/bin/env python3
"""Which release directories a container's bind mounts may still use (ADR-158, addendum 3).

Reads `docker inspect` output (a JSON list) on stdin and prints, one per line, the release names
(40-character commits) that must not be pruned. Exit 3, with the reason on stderr, when it cannot be
sure: the caller then removes no release at all.

Docker Desktop resolves a bind source's symbolic links when it creates the container and keeps the
resolved path, while `docker inspect` still shows the string it was given (2026-09-30: vector's
`~/.hawa/current/infra/docker/vector.yaml` was pinned to `~/.hawa/releases/1737c8f2…`, which the prune
then removed). So a source through `current` (or `previous`) is resolved against the release history
(`<releases>/.history`, one `<UTC time> <commit>` line per activation) at the container's Created time,
and at its last start too (Linux resolves at every start). A time within a few seconds of an activation
keeps the releases on both sides: the history line is written just after the switch, and the Docker
VM's clock may differ from the host's by a moment.
"""
import argparse
import datetime
import json
import os
import re
import sys

COMMIT = re.compile(r'^[0-9a-f]{40}$')
HISTORY_LINE = re.compile(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) ([0-9a-f]{40})$')
SLACK = datetime.timedelta(seconds=3)


class Unsure(Exception):
    pass


def forms(path):
    """The spellings a path may take in a mount source: as given, and with its directory resolved."""
    out = {os.path.normpath(path)}
    parent, name = os.path.split(os.path.normpath(path))
    out.add(os.path.join(os.path.realpath(parent), name))
    return out


def under(source, roots):
    """The first path component below one of the roots, '' for the root itself, else None."""
    for root in roots:
        if source == root:
            return ''
        if source.startswith(root + '/'):
            return source[len(root) + 1:].split('/', 1)[0]
    return None


def parse_time(value):
    # Docker writes RFC 3339 with nanoseconds ("2026-09-30T09:49:56.065469929Z"); Python takes microseconds.
    match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)', value or '')
    if not match:
        raise Unsure('unreadable container time %r' % value)
    zone = '+00:00' if match[3] == 'Z' else match[3]
    stamp = datetime.datetime.fromisoformat(match[1] + '.' + (match[2] or '0')[:6].ljust(6, '0') + zone)
    return stamp.astimezone(datetime.timezone.utc)


def read_history(path):
    """The (time, current, previous) states the links went through, in order; None before any release."""
    states = [(None, None, None)]
    if not os.path.exists(path):
        return states, False
    current = previous = None
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            match = HISTORY_LINE.match(line)
            if not match:
                raise Unsure('unreadable release history line %r' % line)
            when = datetime.datetime.strptime(match[1], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
            if match[2] != current:
                previous, current = current, match[2]
            states.append((when, current, previous))
    return states, True


def at(states, moment, which):
    """Every release `which` (1 current, 2 previous) may have named around that moment."""
    names = set()
    low, high = moment - SLACK, moment + SLACK
    for index, (start, current, previous) in enumerate(states):
        end = states[index + 1][0] if index + 1 < len(states) else None
        # A history line is written just after its switch, and names the second it was written in.
        if (start is None or start <= high) and (end is None or end + datetime.timedelta(seconds=1) > low):
            names.add((current, previous)[which - 1])
    return names


def protected(containers, releases, current, previous, history):
    release_roots, current_roots, previous_roots = forms(releases), forms(current), forms(previous)
    states, has_history = read_history(history)
    keep = set()
    for container in containers:
        name = container.get('Name') or container.get('Id', '?')
        sources = [m.get('Source', '') for m in container.get('Mounts') or [] if m.get('Type') == 'bind']
        sources += [b.split(':', 1)[0] for b in (container.get('HostConfig') or {}).get('Binds') or []]
        for source in sources:
            if not source.startswith('/'):
                continue  # a named volume
            # Docker Desktop records some sources under its VM's view of the Mac's disk.
            if source.startswith('/host_mnt/'):
                source = source[len('/host_mnt'):]
            source = os.path.normpath(source)
            release = under(source, release_roots)
            if release is not None:
                if COMMIT.match(release):
                    keep.add(release)
                elif release == '':
                    raise Unsure('%s binds the releases directory itself (%s)' % (name, source))
                continue
            for roots, which in ((current_roots, 1), (previous_roots, 2)):
                if under(source, roots) is None:
                    continue
                if not has_history:
                    raise Unsure('%s binds %s but there is no release history to resolve it' % (name, source))
                moments = [parse_time(container.get('Created'))]
                started = (container.get('State') or {}).get('StartedAt')
                if started and not started.startswith('0001-'):
                    moments.append(parse_time(started))
                for moment in moments:
                    # A state before any release names none: that container bound Docker's placeholder
                    # directories (2026-09-30 Addendum 2), not a release.
                    keep.update(n for n in at(states, moment, which) if n)
    return keep


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--releases', required=True)
    parser.add_argument('--current', required=True)
    parser.add_argument('--previous', required=True)
    parser.add_argument('--history', required=True)
    args = parser.parse_args()
    try:
        containers = json.load(sys.stdin)
        if not isinstance(containers, list):
            raise Unsure('docker inspect did not return a list')
        for name in sorted(protected(containers, args.releases, args.current, args.previous, args.history)):
            print(name)
    except (Unsure, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(3)


if __name__ == '__main__':
    main()
