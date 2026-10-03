"""Agreement of the production judge with the blind panel, from results.json and panel-scores.json.

Free: reads the stored run, sends nothing. Usage: python3 plans/judge-calibration-2026-10-02/analyze.py
Writes analysis.json beside it and prints the tables used in RESULTS.md.
"""
import json
import statistics as st
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
run = json.loads((HERE / 'results.json').read_text())
panel = json.loads((HERE / 'panel-scores.json').read_text())['images']
frozen = json.loads((HERE / 'frozen-set.json').read_text())
MARGIN = frozen['tieMargin']
results = run['results']


def mean(rows, dim='overall'):
    return st.mean(r[dim] for r in rows)


def score(i, src):
    p = panel[i]
    if src == 'round1':
        return mean(p['round1'])
    if src == 'round2':
        return mean(p['round2'])
    return mean(p['round1'] + p['round2'])


def label(a, b, src, margin=MARGIN):
    d = score(a, src) - score(b, src)
    return 'tie' if abs(d) < margin else ('a' if d > 0 else 'b')


def kappa(xs, ys):
    n = len(xs)
    po = sum(x == y for x, y in zip(xs, ys)) / n
    cx, cy = Counter(xs), Counter(ys)
    pe = sum(cx[k] / n * cy[k] / n for k in ('a', 'b', 'tie'))
    return None if pe == 1 else round((po - pe) / (1 - pe), 3)


def agreement(rows, src, margin=MARGIN):
    labels = [label(r['pair']['a'], r['pair']['b'], src, margin) for r in rows]
    verdicts = [r['verdict'] for r in rows]
    decided = [(l, v) for l, v in zip(labels, verdicts) if l != 'tie' and v != 'tie']
    agree = sum(l == v for l, v in decided)
    # The panel decided, whatever the judge did: a judge tie counts as a miss.
    panel_decided = [(l, v) for l, v in zip(labels, verdicts) if l != 'tie']
    return {
        'pairs': len(rows),
        'panelLabels': dict(Counter(labels)),
        'judgeVerdicts': dict(Counter(verdicts)),
        'decidedBoth': {'pairs': len(decided), 'agree': agree, 'rate': round(agree / len(decided), 3) if decided else None},
        'panelDecided': {'pairs': len(panel_decided), 'judgeRight': sum(l == v for l, v in panel_decided),
                         'judgeTie': sum(v == 'tie' for _, v in panel_decided),
                         'judgeWrong': sum(v not in ('tie', l) for l, v in panel_decided)},
        'threeWay': {'agree': sum(l == v for l, v in zip(labels, verdicts)), 'rate': round(sum(l == v for l, v in zip(labels, verdicts)) / len(rows), 3)},
        'kappa': kappa(labels, verdicts),
    }


def position(rows):
    calls = [w == 'a' for r in rows for w in [r['winnerAFirst']]] + [r['winnerBFirst'] == 'b' for r in rows]
    flips = sum(r['winnerAFirst'] != r['winnerBFirst'] for r in rows)
    return {'pairs': len(rows), 'flips': flips, 'flipRate': round(flips / len(rows), 3),
            'calls': len(calls), 'firstShownWins': sum(calls), 'firstShownWinRate': round(sum(calls) / len(calls), 3)}


kinds = sorted({r['pair']['kind'] for r in results})
out = {
    'main_round1_frozenLabels': agreement(results, 'round1'),
    'round2Labels': agreement(results, 'round2'),
    'allSixPanelJudges': agreement(results, 'both'),
    'byKind_round1': {k: agreement([r for r in results if r['pair']['kind'] == k], 'round1') for k in kinds},
    'byKind_allSix': {k: agreement([r for r in results if r['pair']['kind'] == k], 'both') for k in kinds},
    'position': position(results),
    'positionByKind': {k: position([r for r in results if r['pair']['kind'] == k]) for k in kinds},
}

# How often the two panel rounds give the same label to a pair: the ceiling a judge can reach.
r1 = [label(r['pair']['a'], r['pair']['b'], 'round1') for r in results]
r2 = [label(r['pair']['a'], r['pair']['b'], 'round2') for r in results]
out['panelRound1VsRound2'] = {'sameLabel': sum(x == y for x, y in zip(r1, r2)), 'pairs': len(r1),
                              'kappa': kappa(r1, r2),
                              'decidedBothSame': sum(x == y for x, y in zip(r1, r2) if x != 'tie' and y != 'tie'),
                              'decidedBoth': sum(1 for x, y in zip(r1, r2) if x != 'tie' and y != 'tie'),
                              'opposite': sum(1 for x, y in zip(r1, r2) if {x, y} == {'a', 'b'})}

# Clear pairs: the six panel judges' means differ by a full point or more.
clear = [r for r in results if abs(score(r['pair']['a'], 'both') - score(r['pair']['b'], 'both')) >= 1.0]
out['clearPairs_allSix_1pt'] = agreement(clear, 'both', margin=1.0)

# Group preference on ours_vs_office: how often the judge's consistent verdict and each call favour our render.
ovo = [r for r in results if r['pair']['kind'] == 'ours_vs_office']
per_call_ours = sum((r['winnerAFirst'] == 'a') + (r['winnerBFirst'] == 'a') for r in ovo)
out['oursVsOffice'] = {
    'pairs': len(ovo),
    'judgeVerdict': dict(Counter({'a': 'ours', 'b': 'office', 'tie': 'tie'}[r['verdict']] for r in ovo)),
    'panelRound1': dict(Counter({'a': 'ours', 'b': 'office', 'tie': 'tie'}[label(r['pair']['a'], r['pair']['b'], 'round1')] for r in ovo)),
    'panelAllSix': dict(Counter({'a': 'ours', 'b': 'office', 'tie': 'tie'}[label(r['pair']['a'], r['pair']['b'], 'both')] for r in ovo)),
    'callsOursWins': per_call_ours, 'calls': 2 * len(ovo),
}

# Per office post: the judge's record against our renders vs the panel's score of the post.
office = {}
for r in ovo:
    o = r['pair']['b']
    e = office.setdefault(o, {'file': panel[o]['file'], 'panelRound1': round(score(o, 'round1'), 2), 'panelAllSix': round(score(o, 'both'), 2),
                              'officeWins': 0, 'oursWins': 0, 'ties': 0})
    e[{'a': 'oursWins', 'b': 'officeWins', 'tie': 'ties'}[r['verdict']]] += 1
out['perOfficePost'] = dict(sorted(office.items()))

# Dimension votes: how often each dimension sides with the per-call winner, and with the panel's matching dimension.
DIMS = {'hierarchy': 'hierarchy', 'composition': 'composition', 'typographic_craft': 'typography', 'brand_fit': 'brand_polish', 'legibility': None}
dim = {}
for d, pd in DIMS.items():
    agree = n = 0
    for r in results:
        a, b = r['pair']['a'], r['pair']['b']
        if pd:
            diff = st.mean(x[pd] for x in panel[a]['round1'] + panel[a]['round2']) - st.mean(x[pd] for x in panel[b]['round1'] + panel[b]['round2'])
            if abs(diff) < MARGIN:
                continue
            want = 'a' if diff > 0 else 'b'
            for order, first in (('aFirst', 'a'), ('bFirst', 'b')):
                v = r['votes'][order][d]
                got = first if v == 'A' else ('b' if first == 'a' else 'a')
                n += 1
                agree += got == want
    dim[d] = {'panelDimension': pd, 'calls': n, 'agree': agree, 'rate': round(agree / n, 3) if n else None}
out['dimensionVsPanelDimension_allSix'] = dim

out['cost'] = {'spentUsd': run['run']['spentUsd'], 'paidCalls': run['run']['paidCalls'], 'cachedCalls': run['run']['cachedCalls']}
(HERE / 'analysis.json').write_text(json.dumps(out, indent=1) + '\n')
print(json.dumps(out, indent=1))
