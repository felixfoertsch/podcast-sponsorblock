const { expect } = require('chai')
const fs = require('fs').promises
const os = require('os')
const Path = require('path')
const sinon = require('sinon')
const { ComparisonCorpus } = require('../vendor/adComparisonCorpus')
const { frames, decodeFrames } = require('../vendor/mpegFrameAlignment')

describe('Persistent comparison corpus', () => {
  let dir, corpus
  beforeEach(async () => { dir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-corpus-test-')); corpus = new ComparisonCorpus(Path.join(dir, 'corpus')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const input = (n = 1) => ({ itemId: 'item', episodeId: 'episode', data: Buffer.from(`audio${n}`), fingerprint: [n, 2, 3], duration: 60, provider: 'apple', route: 'direct' })
  it('retains compact frames and raw fingerprints, preserves provenance and deduplicates', async () => {
    const saved = await corpus.retain(input())
    corpus = new ComparisonCorpus(Path.join(dir, 'corpus'))
    const loaded = await corpus.load('item', 'episode')
    expect(loaded.versions[0].fingerprint).to.deep.equal([1, 2, 3])
    expect(loaded.versions[0].sha256).to.equal(saved.sha256)
    expect(loaded.versions[0].audioBytes).to.equal(input().data.length)
    expect(decodeFrames(await fs.readFile(Path.join(dir, 'corpus', saved.versionId, 'frames.bin')))).to.deep.equal(frames(input().data))
    expect(await fs.readdir(Path.join(dir, 'corpus', saved.versionId))).to.have.members(['frames.bin', 'fingerprint.json', 'manifest.json'])
    expect((await corpus.retain(input())).status).to.equal('duplicate')
    expect((await corpus.retain({ ...input(), data: Buffer.from('different') })).status).to.equal('duplicate')
    expect((await corpus.inventory('item', 'episode')).count).to.equal(1)
  })
  it('migrates v1 after verifying provenance, and completes interruption states on explicit load', async () => {
    const saved = await corpus.retain(input())
    const version = Path.join(corpus.root, saved.versionId)
    const manifestPath = Path.join(version, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.version = 1
    manifest.format = 'raw-uint32-json'
    delete manifest.frameBytes
    delete manifest.frameSha256
    const audio = input().data
    const legacy = { ...manifest, version: 1, format: 'raw-uint32-json' }
    await fs.writeFile(Path.join(version, 'audio'), audio, { mode: 0o600 })
    await fs.writeFile(manifestPath, JSON.stringify(legacy), { mode: 0o600 })
    expect((await corpus.inventory('item', 'episode')).count).to.equal(1)
    const first = await corpus.load('item', 'episode', async () => {})
    expect(first.versions[0].version).to.equal(2)
    expect(first.versions[0].sha256).to.equal(saved.sha256)
    expect(first.totalBytes).to.equal((await corpus.inventory('item', 'episode')).totalBytes)
    expect(await fs.readdir(version)).to.have.members(['frames.bin', 'fingerprint.json', 'manifest.json'])

    const second = await corpus.retain(input(2))
    const dir2 = Path.join(corpus.root, second.versionId)
    await fs.writeFile(Path.join(dir2, 'audio'), input(2).data, { mode: 0o600 })
    await expectFailure(() => corpus.load('item', 'episode', async () => { throw new Error('cancelled') }))
    expect(await fs.readFile(Path.join(dir2, 'audio'))).to.deep.equal(input(2).data)
    await corpus.load('item', 'episode')
    expect(await fs.readdir(dir2)).to.have.members(['frames.bin', 'fingerprint.json', 'manifest.json'])
  })
  for (const failure of ['publication', 'reread', 'decode', 'consent']) it(`preserves legacy audio on ${failure} failure, inventory never migrates`, async () => {
    const saved = await corpus.retain(input())
    const version = Path.join(corpus.root, saved.versionId)
    const manifestPath = Path.join(version, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    manifest.version = 1
    manifest.format = 'raw-uint32-json'
    delete manifest.frameBytes
    delete manifest.frameSha256
    const legacy = JSON.stringify(manifest)
    await fs.writeFile(manifestPath, legacy)
    await fs.writeFile(Path.join(version, 'audio'), input().data, { mode: 0o600 })
    await corpus.inventory('item', 'episode')
    expect(await fs.readFile(manifestPath, 'utf8')).to.equal(legacy)
    expect(await fs.readFile(Path.join(version, 'audio'))).to.deep.equal(input().data)
    const rename = fs.rename.bind(fs)
    const stub = sinon.stub(fs, 'rename').callsFake(async (...args) => {
      if (failure === 'publication') throw new Error('publication failed')
      await rename(...args)
      if (failure === 'reread' || failure === 'decode') {
        const encoded = await fs.readFile(Path.join(version, 'frames.bin'))
        encoded.writeDoubleLE(NaN, encoded.length - 8)
        await fs.writeFile(Path.join(version, 'frames.bin'), encoded)
        if (failure === 'decode') {
          const published = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
          published.frameSha256 = require('crypto').createHash('sha256').update(encoded).digest('hex')
          await fs.writeFile(manifestPath, JSON.stringify(published))
        }
      }
    })
    try {
      await expectFailure(() => corpus.load('item', 'episode', async () => {
        if (failure === 'consent' && JSON.parse(await fs.readFile(manifestPath, 'utf8')).version === 2) throw new Error('cancelled')
      }))
    } finally { stub.restore() }
    if (failure === 'decode') await expectFailure(() => corpus.load('item', 'episode'))
    expect(await fs.readFile(Path.join(version, 'audio'))).to.deep.equal(input().data)
  })
  it('preserves audio when existing interrupted legacy frames do not match source', async () => {
    const saved = await corpus.retain(input())
    const version = Path.join(corpus.root, saved.versionId)
    const manifest = JSON.parse(await fs.readFile(Path.join(version, 'manifest.json'), 'utf8'))
    manifest.version = 1
    manifest.format = 'raw-uint32-json'
    delete manifest.frameBytes
    delete manifest.frameSha256
    await fs.writeFile(Path.join(version, 'audio'), input().data, { mode: 0o600 })
    await fs.writeFile(Path.join(version, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
    await fs.writeFile(Path.join(version, 'frames.bin'), Buffer.from('corrupt'), { mode: 0o600 })
    await expectFailure(() => corpus.load('item', 'episode'))
    expect(await fs.readFile(Path.join(version, 'audio'))).to.deep.equal(input().data)
  })
  it('pauses at five, never evicts, and allows offline reads at capacity', async () => {
    for (let n = 1; n <= 5; n++) await corpus.retain(input(n))
    expect((await corpus.retain(input(6))).reason).to.equal('episode_limit')
    expect((await corpus.load('item', 'episode')).versions).to.have.length(5)
    expect((await fs.readdir(Path.join(dir, 'corpus'))).length).to.equal(5)
  })
  it('counts compact frames, fingerprint and manifest bytes and rejects excess without replacing evidence', async () => {
    await corpus.retain(input())
    const before = await corpus.inventory('item', 'episode')
    corpus = new ComparisonCorpus(Path.join(dir, 'corpus'), before.totalBytes + 1)
    expect((await corpus.retain(input(2))).reason).to.equal('corpus_limit')
    expect((await corpus.inventory('item', 'episode')).totalBytes).to.equal(before.totalBytes)
    expect(await fs.readdir(Path.join(dir, 'corpus'))).to.have.length(1)
  })
  it('cleans staging after cancelled or failed publication, preserves old evidence', async () => {
    await corpus.retain(input())
    let checks = 0
    try { await corpus.retain(input(2), async () => { if (++checks === 2) throw new Error('cancelled') }); throw new Error('expected rejection') } catch (e) { expect(e.message).to.equal('cancelled') }
    expect(await fs.readdir(Path.join(dir, 'corpus'))).to.have.length(1)
    expect((await corpus.load('item', 'episode')).versions).to.have.length(1)
  })
  it('syncs metadata parent before publication, retries failed parent sync, preserves post-rename evidence', async () => {
    const open = fs.open.bind(fs)
    let parentAttempts = 0
    const order = []
    let failRoot = false
    const stub = sinon.stub(fs, 'open').callsFake(async (path, ...args) => {
      const handle = await open(path, ...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (path === dir) {
          order.push('parent')
          if (++parentAttempts === 1) throw Object.assign(new Error('parent sync failed'), { code: 'EIO' })
        }
        if (path === corpus.root) { order.push('root'); if (failRoot) throw new Error('root sync failed') }
        return sync()
      }
      return handle
    })
    try {
      await expectFailure(() => corpus.retain(input()))
      expect((await corpus.inventory('item', 'episode')).count).to.equal(0)
      await corpus.retain(input())
      expect(parentAttempts).to.equal(2)
      expect(order).to.deep.equal(['parent', 'parent', 'root'])
      failRoot = true
      await expectFailure(() => corpus.retain(input(2)))
      expect((await corpus.inventory('item', 'episode')).count).to.equal(2)
      expect((await fs.readdir(corpus.root)).some((name) => name.startsWith('.stage-'))).to.equal(false)
    } finally { stub.restore() }
  })
  it('cleans staging on ENOSPC without touching published versions', async () => {
    await corpus.retain(input())
    const open = fs.open.bind(fs)
    const stub = sinon.stub(fs, 'open').callsFake(async (path, ...args) => {
      if (String(path).includes('.stage-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return open(path, ...args)
    })
    try { await expectFailure(() => corpus.retain(input(2))) } finally { stub.restore() }
    expect(await fs.readdir(Path.join(dir, 'corpus'))).to.have.length(1)
    expect((await corpus.load('item', 'episode')).versions).to.have.length(1)
  })
  it('rejects traversal IDs and substituted root or version directories', async () => {
    await expectFailure(() => corpus.retain({ ...input(), episodeId: '../escape' }))
    const saved = await corpus.retain(input())
    const version = Path.join(dir, 'corpus', saved.versionId)
    await fs.rename(version, Path.join(dir, 'outside'))
    await fs.symlink(Path.join(dir, 'outside'), version)
    await expectFailure(() => corpus.load('item', 'episode'))
  })
  it('fails closed on malformed manifests and symlinks without deleting evidence', async () => {
    const saved = await corpus.retain(input())
    const manifest = Path.join(dir, 'corpus', saved.versionId, 'manifest.json')
    await fs.writeFile(manifest, '{"audio":"../../outside"}')
    await expectFailure(() => corpus.inventory('item', 'episode'))
    expect(await fs.readdir(Path.join(dir, 'corpus'))).to.have.length(1)
    await fs.rm(manifest)
    await fs.symlink(Path.join(dir, 'missing'), manifest)
    await expectFailure(() => corpus.load('item', 'episode'))
  })
})
async function expectFailure(fn) { let failed = false; try { await fn() } catch { failed = true } expect(failed).to.equal(true) }
