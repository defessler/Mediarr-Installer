import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { PYTHON, NAS_SCRIPTS, runPython } from '../helpers/shell.js'

// purge_dir is the only place LibrARRian deletes files itself rather than
// asking an arr to. Everything else it does is recoverable BECAUSE it lands in
// the recycle bin; this empties the bin, so there is nothing underneath it.
//
// That earns a real test. The things that would actually hurt: escaping the
// bin via a symlink or a "..", removing the bin directory itself (the arrs
// reject their whole media-management config when the recycleBin path is
// missing, so the next wizard run would fail for unrelated-looking reasons),
// or reporting bytes it didn't actually free.

const LIBRARIAN = join(NAS_SCRIPTS, 'librarian.py')

function py(body: string): any {
  const program = [
    'import importlib.util, json, os, tempfile, shutil',
    `spec = importlib.util.spec_from_file_location('lib', ${JSON.stringify(LIBRARIAN)})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'out = {}',
    body,
    'print(json.dumps(out, default=str))',
  ].join('\n')
  const r = runPython(program)
  expect(r.status, `python exited ${r.status}: ${r.stdout}`).toBe(0)
  return JSON.parse(r.stdout.trim().split('\n').pop() as string)
}

// One tree, many assertions — building it is the slow part.
const FIXTURE = `
root = tempfile.mkdtemp()
bin_dir = os.path.join(root, '.recycle', 'sonarr')
os.makedirs(bin_dir)
outside = os.path.join(root, 'PRECIOUS')
os.makedirs(outside)
open(os.path.join(outside, 'media.mkv'), 'wb').write(b'x' * 5000)
open(os.path.join(bin_dir, 'a.mkv'), 'wb').write(b'x' * 1000)
os.makedirs(os.path.join(bin_dir, 'Season 01'))
open(os.path.join(bin_dir, 'Season 01', 'b.mkv'), 'wb').write(b'x' * 2000)
open(os.path.join(bin_dir, 'Season 01', 'c.mkv'), 'wb').write(b'x' * 500)
out['linked'] = False
try:
    os.symlink(outside, os.path.join(bin_dir, 'escape'))
    out['linked'] = True
except Exception:
    pass
`

describe.skipIf(!PYTHON)('LibrARRian recycle bin', () => {
  it('measures only what is really in the bin', () => {
    const r = py(`${FIXTURE}
used, count = m.recycle_usage(bin_dir)
out['bytes'] = used
out['files'] = count
shutil.rmtree(root, ignore_errors=True)`)
    // 1000 + 2000 + 500. A symlinked directory's contents are somebody
    // else's disk usage and must not be counted as reclaimable.
    expect(r.bytes).toBe(3500)
    expect(r.files).toBe(3)
  })

  it('empties the bin, keeps the bin folder, and never escapes it', () => {
    const r = py(`${FIXTURE}
files, freed, errors = m.purge_dir(bin_dir)
out['files'] = files
out['freed'] = freed
out['errors'] = errors
out['bin_still_there'] = os.path.isdir(bin_dir)
out['bin_empty'] = os.listdir(bin_dir) == []
out['outside_survived'] = os.path.isfile(os.path.join(outside, 'media.mkv'))
out['link_gone'] = not os.path.lexists(os.path.join(bin_dir, 'escape'))
shutil.rmtree(root, ignore_errors=True)`)
    expect(r.errors).toEqual([])
    expect(r.freed).toBe(3500)
    expect(r.files).toBe(3 + (r.linked ? 1 : 0))
    expect(r.bin_empty, 'bin should be empty').toBe(true)
    // The arrs reject their entire media-management config if recycleBin
    // points at something that isn't there, so the folder has to survive.
    expect(r.bin_still_there, 'bin folder must survive the purge').toBe(true)
    expect(r.outside_survived, 'a symlink must not be followed out of the bin').toBe(true)
    if (r.linked) expect(r.link_gone, 'the symlink itself should be removed').toBe(true)
  })

  it('resolves an arr path to the local mount, and refuses anything else', () => {
    const r = py(`${FIXTURE}
env = {'DATA_ROOT': root}
out['ok']        = m.recycle_local_path('/data/.recycle/sonarr', env)
out['traversal'] = m.recycle_local_path('/data/.recycle/..', env)
out['dotdotdot'] = m.recycle_local_path('/data/.recycle/../../etc', env)
out['unknown']   = m.recycle_local_path('/data/.recycle/nope', env)
out['empty']     = m.recycle_local_path('', env)
out['no_root']   = m.recycle_local_path('/data/.recycle/sonarr', {})
out['host']      = m.recycle_host_path('/data/.recycle/sonarr', {'DATA_ROOT': '/volume1/Data'})
out['host_odd']  = m.recycle_host_path('/mnt/elsewhere/bin', {'DATA_ROOT': '/volume1/Data'})
shutil.rmtree(root, ignore_errors=True)`)
    expect(r.ok).toMatch(/[/\\]\.recycle[/\\]sonarr$/)
    // Only the last segment is trusted; a traversal resolves to nothing
    // rather than to a directory above the bin.
    expect(r.traversal).toBe('')
    expect(r.dotdotdot).toBe('')
    expect(r.unknown, 'a bin that is not mounted is unreadable, not guessed').toBe('')
    expect(r.empty).toBe('')
    expect(r.no_root, 'without DATA_ROOT there is nothing to resolve against').toBe('')
    // Display path: the arrs say /data, humans type the real thing.
    expect(r.host).toBe('/volume1/Data/.recycle/sonarr')
    expect(r.host_odd, 'a path outside /data is shown as-is').toBe('/mnt/elsewhere/bin')
  })

  it('refuses to plan an empty when write mode is off', () => {
    const r = py(`
report = {'recycle': [{'arr': 'sonarr', 'label': 'Sonarr', 'path': '/data/.recycle/sonarr',
                       'host_path': '/v/Data/.recycle/sonarr', 'cleanup_days': 30,
                       'bytes': 100, 'files': 2, 'readable': True}]}
try:
    m.build_empty_plan(report, {'LIBRARIAN_ALLOW_ACTIONS': 'false'})
    out['refused'] = False
except m.LibrarianSourceError as e:
    out['refused'] = True
    out['why'] = str(e)
plan = m.build_empty_plan(report, {})
out['mode'] = plan['mode']
out['total'] = plan['total_size']
out['deletes'] = plan['deletes_files']
out['arr'] = plan['arr']
try:
    m.build_empty_plan({'recycle': []}, {})
    out['empty_refused'] = False
except m.LibrarianSourceError:
    out['empty_refused'] = True`)
    expect(r.refused, 'read-only mode must not build a delete plan').toBe(true)
    expect(r.why).toMatch(/LIBRARIAN_ALLOW_ACTIONS/)
    // Write mode is default-on, so a bare env still plans.
    expect(r.mode).toBe('empty')
    expect(r.total).toBe(100)
    expect(r.deletes).toBe(true)
    // No single arr owns this action; /apply skips its reachability check
    // on the strength of that.
    expect(r.arr).toBe('')
    expect(r.empty_refused, 'nothing to delete should refuse, not no-op').toBe(true)
  })
})
