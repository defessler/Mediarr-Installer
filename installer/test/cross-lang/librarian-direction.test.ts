import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// Upgrade and Shrink used to be two buttons, which asked the user to work out
// something the page already knows: whether the profile they picked is above
// or below what each item currently has. Now one button applies the profile
// and build_plan decides, per item, whether the files have to be deleted first.
//
// Getting that decision wrong in one direction costs a re-download. Getting it
// wrong in the other deletes files that didn't need deleting. So the rule is
// pinned here, especially the fail-safe: anything the rank can't be read for
// must never come out as "delete this".

const LIBRARIAN = join(NAS_SCRIPTS, 'librarian.py')

const PRELUDE = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('lib', ${JSON.stringify(LIBRARIAN)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {}

QUALITIES = ['SDTV', 'WEBDL-720p', 'WEBDL-1080p', 'Bluray-1080p', 'WEBDL-2160p', 'Remux-2160p']

def prof(pid, name, allow_upto):
    """Every profile in an app lists the SAME qualities in the SAME order;
    only the allowed flags differ. That's what makes rank comparable."""
    return {'id': pid, 'name': name,
            'items': [{'quality': {'id': i, 'name': q}, 'allowed': i <= allow_upto, 'items': []}
                      for i, q in enumerate(QUALITIES)]}

RAW = [prof(1, 'SD', 0), prof(2, 'HD-1080p', 3), prof(3, 'UHD', 5)]
PROFILES = [{'id': p['id'], 'name': p['name'], 'rank': m.profile_rank(p)} for p in RAW]

def item(i, title, prof_id, size=10**10):
    return {'id': i, 'title': title, 'arr': 'radarr', 'profile': prof_id,
            'size': size, 'quality': 'x', 'year': 2021, 'path': '/x'}

def report(items, arr='radarr'):
    return {'connections': {arr: {'base': 'http://x', 'key': 'k', 'api': 'v3',
                                  'profiles': PROFILES}},
            'items': items}

# Stub the one network call build_plan makes on a downgrade.
m.recycle_bin_path = lambda *a, **k: '/data/.recycle/radarr'
`

function py(body: string): any {
  const r = runPython(`${PRELUDE}\n${body}\nprint(json.dumps(out, default=str))`)
  expect(r.status, `python exited ${r.status}: ${r.stdout}`).toBe(0)
  return JSON.parse(r.stdout.trim().split('\n').pop() as string)
}

describe.skipIf(!PYTHON)('LibrARRian works out the direction itself', () => {
  it('ranks profiles by the best quality they allow', () => {
    const r = py(`
out['ranks'] = {p['name']: p['rank'] for p in PROFILES}
# Radarr nests things like "WEB 1080p" as a GROUP. The best allowed quality
# sits inside it, so the walk has to descend and carry the group's flag down.
grouped = {'id': 4, 'name': 'Grouped', 'items': [
    {'quality': {'id': 0, 'name': 'SDTV'}, 'allowed': False, 'items': []},
    {'name': 'WEB 1080p', 'allowed': True, 'items': [
        {'quality': {'id': 1, 'name': 'WEBDL-1080p'}, 'allowed': True, 'items': []},
        {'quality': {'id': 2, 'name': 'WEBRip-1080p'}, 'allowed': True, 'items': []}]},
    {'quality': {'id': 3, 'name': 'Remux-2160p'}, 'allowed': False, 'items': []}]}
out['grouped'] = m.profile_rank(grouped)
out['unreadable'] = m.profile_rank({'id': 9, 'name': 'Weird'})
out['no_allowed'] = m.profile_rank(prof(5, 'Nothing', -1))`)
    expect(r.ranks.SD).toBeLessThan(r.ranks['HD-1080p'])
    expect(r.ranks['HD-1080p']).toBeLessThan(r.ranks.UHD)
    expect(r.grouped, 'best allowed is the 3rd leaf, inside the group').toBe(2)
    expect(r.unreadable, 'a profile with no items ranks -1').toBe(-1)
    expect(r.no_allowed, 'a profile allowing nothing ranks -1').toBe(-1)
  })

  it('deletes nothing when the target is higher, or the same', () => {
    const r = py(`
higher = m.build_plan(report([item(1, 'A', 2)]), {}, 'radarr', 3, [1])
same   = m.build_plan(report([item(1, 'A', 2)]), {}, 'radarr', 2, [1])
out['higher'] = higher['deletes_files']
out['same'] = same['deletes_files']
out['dirs'] = [i['direction'] for i in higher['items']]
out['mode'] = higher['mode']`)
    expect(r.higher).toBe(false)
    expect(r.same, 'the same profile is not a downgrade').toBe(false)
    expect(r.dirs).toEqual(['up'])
    expect(r.mode, 'one mode now, not upgrade/shrink').toBe('apply')
  })

  it('deletes only the items actually above the target', () => {
    const r = py(`
# One UHD item and one SD item, both re-graded to HD. Only the UHD one is
# a downgrade; deleting the SD one would be destroying a file for nothing.
plan = m.build_plan(report([item(1, 'BigRemux', 3), item(2, 'TinySD', 1)]),
                    {}, 'radarr', 2, [1, 2])
out['deletes'] = plan['deletes_files']
out['down_ids'] = plan['down_ids']
out['dirs'] = {i['title']: i['direction'] for i in plan['items']}
out['down_size'] = plan['down_size']
out['total_size'] = plan['total_size']
out['steps'] = plan['steps']`)
    expect(r.deletes).toBe(true)
    expect(r.down_ids, 'only the item above the target').toEqual([1])
    expect(r.dirs).toEqual({ BigRemux: 'down', TinySD: 'up' })
    // The warning quotes the size actually at risk, not the whole selection.
    expect(r.down_size).toBe(10 ** 10)
    expect(r.total_size).toBe(2 * 10 ** 10)
    expect(r.steps.join(' '), 'the plan says the others are left alone')
      .toMatch(/Leave the other 1 item/)
  })

  it('never deletes on a rank it could not read', () => {
    const r = py(`
# Current profile isn't in the list at all, and the target is the LOWEST
# profile there is. Still must not delete: an unreadable rank is not
# evidence that the file is too good.
plan = m.build_plan(report([item(1, 'A', 999)]), {}, 'radarr', 1, [1])
out['deletes'] = plan['deletes_files']
out['dirs'] = [i['direction'] for i in plan['items']]`)
    expect(r.deletes, 'unknown rank must fall back to the non-destructive path').toBe(false)
    expect(r.dirs).toEqual(['up'])
  })

  it('still refuses a downgrade on Lidarr, but allows an upgrade', () => {
    const r = py(`
def lidarr_report(prof_id):
    rep = report([{'id': 1, 'title': 'Band', 'arr': 'lidarr', 'profile': prof_id,
                   'size': 10**9, 'quality': 'x', 'year': None, 'path': '/x'}], arr='lidarr')
    return rep
try:
    m.build_plan(lidarr_report(3), {}, 'lidarr', 1, [1])
    out['down_refused'] = False
except m.LibrarianSourceError as e:
    out['down_refused'] = True
    out['why'] = str(e)
up = m.build_plan(lidarr_report(1), {}, 'lidarr', 3, [1])
out['up_ok'] = up['deletes_files'] is False`)
    // Shrinking an artist means deleting every track file they own.
    expect(r.down_refused).toBe(true)
    expect(r.why).toMatch(/lidarr/i)
    expect(r.up_ok, 'upgrading Lidarr was always fine and still is').toBe(true)
  })

  it('refuses a downgrade when there is no Recycle Bin to catch it', () => {
    const r = py(`
m.recycle_bin_path = lambda *a, **k: ''
try:
    m.build_plan(report([item(1, 'A', 3)]), {}, 'radarr', 1, [1])
    out['refused'] = False
except m.LibrarianSourceError as e:
    out['refused'] = True
    out['why'] = str(e)
# An upgrade needs no bin, because it deletes nothing.
out['up_still_fine'] = m.build_plan(report([item(1, 'A', 1)]), {}, 'radarr', 3, [1])['deletes_files']`)
    expect(r.refused).toBe(true)
    expect(r.why).toMatch(/Recycle Bin/)
    expect(r.up_still_fine, 'an upgrade needs no recycle bin').toBe(false)
  })
})
