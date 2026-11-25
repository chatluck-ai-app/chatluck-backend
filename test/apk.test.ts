import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApk, extractErrors } from '../src/tools/apk.ts';

const J = (o: any, status = 200) => new Response(JSON.stringify(o), { status });
async function fakeArtifact() { const JSZip: any = (await import('jszip')).default; const z = new JSZip(); z.file('app/build/outputs/apk/debug/app-debug.apk', Buffer.concat([Buffer.from([0x50, 0x4b]), Buffer.alloc(20000, 1)])); return await z.generateAsync({ type: 'nodebuffer' }); }

test('buildApk: success path creates branch, waits for run, extracts apk, cleans up', async () => {
  const calls: string[] = []; let polls = 0; let treeBody: any;
  const art = await fakeArtifact();
  const fetchImpl: any = async (url: string, init: any = {}) => {
    const m = init.method ?? 'GET'; calls.push(m + ' ' + url.replace('https://api.github.com/repos/o/r', ''));
    assert.equal(init.headers.authorization, 'Bearer T');
    if (url.endsWith('/git/trees')) { treeBody = JSON.parse(init.body); return J({ sha: 'tree1' }); }
    if (url.endsWith('/git/commits')) return J({ sha: 'c1' });
    if (url.endsWith('/git/refs')) return J({ ref: 'x' });
    if (url.includes('/actions/runs?')) return J({ workflow_runs: ++polls < 2 ? [{ id: 9, status: 'in_progress' }] : [{ id: 9, status: 'completed', conclusion: 'success', html_url: 'http://run' }] });
    if (url.endsWith('/artifacts')) return J({ artifacts: [{ archive_download_url: 'https://api.github.com/art/zip' }] });
    if (url.includes('/art/zip')) return new Response(art);
    if (m === 'DELETE') return new Response(null, { status: 204 });
    return J({}, 404);
  };
  const r = await buildApk({ token: 'T', repo: 'o/r', files: [{ path: 'settings.gradle.kts', content: 'x' }, { path: '.github/workflows/evil.yml', content: 'bad' }], fetchImpl, pollMs: 1, id: 'a' });
  assert.equal(r.ok, true); assert.ok(r.apk!.length > 10000); assert.equal(r.apkName, 'app-debug.apk');
  const paths = treeBody.tree.map((t: any) => t.path);
  assert.ok(paths.includes('.github/workflows/build.yml') && paths.includes('gradle.properties') && !paths.includes('.github/workflows/evil.yml'));
  assert.ok(calls.some(c => c.startsWith('DELETE ') && c.includes('/git/refs/heads/build-a')));
});

test('buildApk: failure returns compiler error lines', async () => {
  const fetchImpl: any = async (url: string, init: any = {}) => {
    if (url.endsWith('/git/trees')) return J({ sha: 't' }); if (url.endsWith('/git/commits')) return J({ sha: 'c' }); if (url.endsWith('/git/refs')) return J({});
    if (url.includes('/actions/runs?')) return J({ workflow_runs: [{ id: 1, status: 'completed', conclusion: 'failure', html_url: 'http://run' }] });
    if (url.endsWith('/jobs')) return J({ jobs: [{ id: 5, conclusion: 'failure' }] });
    if (url.endsWith('/logs')) return new Response('2026-01-01T00:00:00.0Z noise\n2026-01-01T00:00:01.0Z e: file:///MainActivity.kt:12:5 Unresolved reference: foo\n> Task :app:compileDebugKotlin FAILED');
    return new Response(null, { status: 204 });
  };
  const r = await buildApk({ token: 'T', repo: 'o/r', files: [{ path: 'a', content: 'b' }], fetchImpl, pollMs: 1 });
  assert.equal(r.ok, false); assert.ok(r.errorLines!.includes('Unresolved reference: foo')); assert.ok(!r.errorLines!.includes('noise'));
});
test('extractErrors falls back to the tail', () => assert.equal(extractErrors('a\nb\nc', 2), 'b\nc'));
