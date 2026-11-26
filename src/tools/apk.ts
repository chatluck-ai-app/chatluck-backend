// Builds an Android project on GitHub Actions (free) and returns the real debug APK.
export const BUILD_WORKFLOW = `name: build-apk
on:
  push:
    branches: ['build-**']
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.7'
      - name: Accept SDK licenses
        run: yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null || true
      - name: Build debug APK
        run: gradle assembleDebug --no-daemon --stacktrace
      - uses: actions/upload-artifact@v4
        with:
          name: app-debug-apk
          path: '**/build/outputs/apk/debug/*.apk'
`;
export const DEFAULT_GRADLE_PROPERTIES = 'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8\nandroid.useAndroidX=true\nandroid.nonTransitiveRClass=true\nkotlin.code.style=official\n';

export interface BuildResult { ok: boolean; logTail?: string; apk?: Buffer; apkName?: string; runUrl?: string; errorLines?: string; note?: string }
export interface BuildOpts { token: string; repo: string; files: { path: string; content: string }[]; fetchImpl?: typeof fetch; signal?: AbortSignal; pollMs?: number; maxWaitMs?: number; id?: string; workflow?: string; apk?: boolean; keepDefaultProps?: boolean }

export function extractErrors(log: string, max = 40) {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trimEnd());
  const re = /(^e: |error:|^ERROR:|FAILURE:|What went wrong|Execution failed|Could not |Unresolved reference|> Task .* FAILED|AAPT|Manifest merger)/i;
  const idx = new Set<number>();
  lines.forEach((l, i) => { if (re.test(l)) idx.add(i); });
  // Gradle puts the real reason on the lines right after "What went wrong" -
  // include them, otherwise the model fixes blind.
  lines.forEach((l, i) => { if (/What went wrong/.test(l)) { for (let k = i; k <= Math.min(i + 8, lines.length - 1); k++) { if (k > i && /^\*\s/.test(lines[k])) break; idx.add(k); } } });
  const pick = idx.size ? [...idx].sort((a, b) => a - b).map(i => lines[i]) : lines.filter(l => l.trim()).slice(-max);
  return pick.slice(-max).join('\n').slice(0, 5000);
}

const cleanTail = (log: string, n = 3500) => log.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '')).filter(l => l.trim()).join('\n').slice(-n);

export type CiKind = 'node' | 'python' | 'android' | 'web' | 'custom';
/** Test workflow: the model-supplied command goes in .ci/run.sh (never interpolated into YAML) and runs on an ephemeral GitHub runner with read-only permissions and no secrets. */
export function testWorkflow(kind: CiKind) {
  const setup = kind === 'node' || kind === 'web' ? `      - uses: actions/setup-node@v4
        with:
          node-version: '20'\n` : kind === 'python' ? `      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'\n` : kind === 'android' ? `      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.7'\n` : '';
  return `name: run-tests
on:
  push:
    branches: ['build-**']
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
${setup}      - name: Run
        run: bash .ci/run.sh
`;
}
export function testScript(kind: CiKind, command?: string) {
  const dflt: Record<string, string> = {
    node: '[ -f package.json ] && npm install --no-audit --no-fund; npm test --if-present',
    web: '[ -f package.json ] && npm install --no-audit --no-fund; npm test --if-present; if [ ! -f package.json ]; then ls; echo "static site: checking html files"; for f in $(find . -name "*.html"); do test -s "$f" && echo "ok $f"; done; fi',
    python: '[ -f requirements.txt ] && pip install -r requirements.txt; if ls test*.py tests 2>/dev/null | head -1 | grep -q .; then python -m pytest -q 2>&1 || python -m unittest discover -v; else python -m compileall -q . && echo compiled-ok; fi',
    android: 'gradle testDebugUnitTest --no-daemon --console=plain',
  };
  return '#!/usr/bin/env bash\nset -o pipefail\n' + (command && command.trim() ? command.trim() : dflt[kind] ?? 'echo "no command given"; exit 1') + '\n';
}

export async function buildApk(o: BuildOpts): Promise<BuildResult> {
  const f = o.fetchImpl ?? fetch; const API = 'https://api.github.com/repos/' + o.repo;
  const H = { authorization: 'Bearer ' + o.token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'chatluck' };
  const sig = () => AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(60000)]);
  const call = async (path: string, init: any = {}) => {
    const r = await f(path.startsWith('http') ? path : API + path, { ...init, headers: { ...H, ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: sig() });
    return r;
  };
  const json = async (path: string, init?: any) => { const r = await call(path, init); const j: any = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`GitHub ${r.status}: ${String(j.message ?? '').slice(0, 200)}`); return j; };
  const files = o.files.filter(x => !x.path.startsWith('.github/'));
  if (o.apk !== false && !files.some(x => x.path === 'gradle.properties')) files.push({ path: 'gradle.properties', content: DEFAULT_GRADLE_PROPERTIES });
  files.push({ path: '.github/workflows/build.yml', content: o.workflow ?? BUILD_WORKFLOW });
  const branch = 'build-' + (o.id ?? Date.now().toString(36));
  const tree = await json('/git/trees', { method: 'POST', body: JSON.stringify({ tree: files.map(x => ({ path: x.path, mode: '100644', type: 'blob', content: x.content })) }) });
  const commit = await json('/git/commits', { method: 'POST', body: JSON.stringify({ message: 'build ' + branch, tree: tree.sha, parents: [] }) });
  await json('/git/refs', { method: 'POST', body: JSON.stringify({ ref: 'refs/heads/' + branch, sha: commit.sha }) });
  try {
    const deadline = Date.now() + (o.maxWaitMs ?? 11 * 60000); let run: any = null;
    while (Date.now() < deadline) {
      if (o.signal?.aborted) throw new Error('canceled');
      await new Promise(r => setTimeout(r, o.pollMs ?? 10000));
      const j = await json(`/actions/runs?head_sha=${commit.sha}&per_page=5`);
      run = (j.workflow_runs ?? [])[0] ?? null;
      if (run?.status === 'completed') break;
    }
    if (!run || run.status !== 'completed') return { ok: false, note: 'انتهت مهلة الانتظار قبل اكتمال البناء', runUrl: run?.html_url };
    let log = '';
    if (run.conclusion !== 'success' || o.apk === false) {
      try {
        const jobs = await json(`/actions/runs/${run.id}/jobs`);
        const job = (jobs.jobs ?? []).find((x: any) => x.conclusion === 'failure') ?? jobs.jobs?.[0];
        if (job) { const r = await call(`/actions/jobs/${job.id}/logs`); log = await r.text(); }
      } catch { /* keep empty */ }
    }
    if (run.conclusion !== 'success') return { ok: false, runUrl: run.html_url, errorLines: extractErrors(log) || 'لا توجد سجلات متاحة', logTail: cleanTail(log), note: 'فشل: ' + run.conclusion };
    if (o.apk === false) return { ok: true, runUrl: run.html_url, logTail: cleanTail(log) };
    const arts = await json(`/actions/runs/${run.id}/artifacts`);
    const art = (arts.artifacts ?? [])[0]; if (!art) return { ok: false, runUrl: run.html_url, note: 'نجح البناء لكن لم يظهر ملف APK' };
    const r = await call(art.archive_download_url); if (!r.ok) throw new Error('artifact download failed: ' + r.status);
    const JSZip: any = (await import('jszip')).default; const z = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
    const name = Object.keys(z.files).find(n => /\.apk$/i.test(n)); if (!name) return { ok: false, runUrl: run.html_url, note: 'الأرشيف لا يحتوي APK' };
    const apk: Buffer = await z.file(name).async('nodebuffer');
    if (apk.length < 10000 || apk[0] !== 0x50 || apk[1] !== 0x4b) return { ok: false, runUrl: run.html_url, note: 'ملف APK غير صالح' };
    return { ok: true, apk, apkName: name.split('/').pop(), runUrl: run.html_url };
  } finally {
    try { await call('/git/refs/heads/' + branch, { method: 'DELETE' }); } catch { /* ignore */ }
  }
}
