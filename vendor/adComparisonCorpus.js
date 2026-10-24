const fs = require('fs')
const Path = require('path')
const crypto = require('crypto')
const fsp = fs.promises
const { encodeFrames, decodeFrames } = require('./mpegFrameAlignment')
const ALGORITHM = 'chromaprint-test2-inward-v1'
const MAX_AUDIO = 256 * 1024 * 1024
const MAX_FP = 2 * 1024 * 1024
const MAX_FRAMES = 24 * 1024 * 1024
const LIMIT = 10 * 1024 * 1024 * 1024
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex')
const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
const hex = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const validFingerprint = (fp) => Array.isArray(fp) && fp.length > 0 && fp.length <= 120000 && fp.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)

async function regular(path, max) {
  const handle = await fsp.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || (stat.mode & 0o077)) throw new Error('corpus_invalid')
    return await handle.readFile()
  } finally { await handle.close() }
}
async function syncDir(path) {
  const handle = await fsp.open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function writeSync(path, bytes) {
  const file = await fsp.open(path, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}
function validFrames(value) {
  return value && ArrayBuffer.isView(value.hashes) && ArrayBuffer.isView(value.times) && value.hashes.length + 1 === value.times.length
}
const v1keys = 'algorithm,audioBytes,collectedAt,duration,episodeId,fingerprintBytes,fingerprintSha256,format,itemId,provider,route,sha256,version,versionId'
const v2keys = 'algorithm,audioBytes,collectedAt,duration,episodeId,fingerprintBytes,fingerprintSha256,format,frameBytes,frameSha256,itemId,provider,route,sha256,version,versionId'

class ComparisonCorpus {
  constructor(root = Path.join(global.MetadataPath, 'ad-analysis-corpus'), limit = LIMIT) { this.root = root; this.limit = limit }

  async scan() {
    const stat = await fsp.lstat(this.root).catch((e) => { if (e.code !== 'ENOENT') throw e })
    if (!stat) return { versions: [], totalBytes: 0 }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('corpus_invalid')
    const versions = []
    let totalBytes = 0
    for (const entry of await fsp.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw new Error('corpus_invalid')
      const dir = Path.join(this.root, entry.name)
      const ds = await fsp.lstat(dir)
      if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077)) throw new Error('corpus_invalid')
      const names = (await fsp.readdir(dir)).sort()
      const bytes = await regular(Path.join(dir, 'manifest.json'), 4096)
      const m = JSON.parse(bytes)
      const common = m.algorithm === ALGORITHM && m.versionId === entry.name && validId(m.itemId) && validId(m.episodeId) && hex(m.sha256) && hex(m.fingerprintSha256) && ['apple', 'gpodder'].includes(m.provider) && ['direct', 'vpn_proxy'].includes(m.route) && Number.isFinite(m.duration) && m.duration >= 50 && m.duration <= 14400 && typeof m.collectedAt === 'string' && new Date(m.collectedAt).toISOString() === m.collectedAt && Number.isInteger(m.audioBytes) && m.audioBytes >= 1 && m.audioBytes <= MAX_AUDIO && Number.isInteger(m.fingerprintBytes) && m.fingerprintBytes >= 1 && m.fingerprintBytes <= MAX_FP
      if (!common || m.versionId !== digest(JSON.stringify([m.itemId, m.episodeId, m.sha256, m.fingerprintSha256]))) throw new Error('corpus_invalid')
      if (m.version === 1) {
        const allowed = ['audio', 'fingerprint.json', 'manifest.json', 'frames.bin', 'manifest.next']
        if (m.format !== 'raw-uint32-json' || Object.keys(m).sort().join(',') !== v1keys || names.some((n) => !allowed.includes(n)) || !['audio', 'fingerprint.json', 'manifest.json'].every((n) => names.includes(n)) || (names.includes('manifest.next') && !names.includes('frames.bin'))) throw new Error('corpus_invalid')
        await this.checkFiles(dir, [['audio', m.audioBytes], ['fingerprint.json', m.fingerprintBytes]])
        if (names.includes('frames.bin')) await regular(Path.join(dir, 'frames.bin'), MAX_FRAMES)
        if (names.includes('manifest.next')) await regular(Path.join(dir, 'manifest.next'), 4096)
      } else if (m.version === 2) {
        if (m.format !== 'mpeg-frames-v1' || !hex(m.frameSha256) || !Number.isInteger(m.frameBytes) || m.frameBytes < 1 || m.frameBytes > MAX_FRAMES || Object.keys(m).sort().join(',') !== v2keys || names.some((n) => !['frames.bin', 'fingerprint.json', 'manifest.json', 'audio'].includes(n)) || !['frames.bin', 'fingerprint.json', 'manifest.json'].every((n) => names.includes(n))) throw new Error('corpus_invalid')
        await this.checkFiles(dir, [['frames.bin', m.frameBytes], ['fingerprint.json', m.fingerprintBytes]])
        if (names.includes('audio')) await this.checkFiles(dir, [['audio', m.audioBytes]])
      } else throw new Error('corpus_invalid')
      if (versions.filter((v) => v.itemId === m.itemId && v.episodeId === m.episodeId).length >= 5) throw new Error('corpus_invalid')
      totalBytes += m.fingerprintBytes + bytes.length
      if (m.version === 1) {
        totalBytes += m.audioBytes
        if (names.includes('frames.bin')) totalBytes += (await regular(Path.join(dir, 'frames.bin'), MAX_FRAMES)).length
        if (names.includes('manifest.next')) totalBytes += (await regular(Path.join(dir, 'manifest.next'), 4096)).length
      } else {
        totalBytes += m.frameBytes
        if (names.includes('audio')) totalBytes += m.audioBytes
      }
      if (!Number.isSafeInteger(totalBytes)) throw new Error('corpus_invalid')
      versions.push(m)
    }
    return { versions, totalBytes }
  }

  async checkFiles(dir, files) {
    for (const [name, size] of files) {
      const stat = await fsp.lstat(Path.join(dir, name))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== size || (stat.mode & 0o077)) throw new Error('corpus_invalid')
    }
  }

  async inventory(itemId, episodeId) {
    if (!validId(itemId) || !validId(episodeId)) throw new Error('corpus_invalid_id')
    const state = await this.scan()
    const versions = state.versions.filter((m) => m.itemId === itemId && m.episodeId === episodeId)
    const reason = versions.length >= 5 ? 'episode_limit' : this.limit - state.totalBytes < MAX_FP + MAX_FRAMES + 4096 ? 'corpus_limit' : null
    return { version: 2, count: versions.length, totalBytes: state.totalBytes, limitBytes: this.limit, collectionPaused: !!reason, reason, versions }
  }

  async load(itemId, episodeId, checkpoint = async () => {}) {
    const state = await this.inventory(itemId, episodeId)
    for (const m of state.versions) {
      const dir = Path.join(this.root, m.versionId)
      const bytes = await regular(Path.join(dir, 'fingerprint.json'), MAX_FP)
      const fingerprint = JSON.parse(bytes)
      if (digest(bytes) !== m.fingerprintSha256 || !validFingerprint(fingerprint)) throw new Error('corpus_invalid')
      if (m.version === 1) await this.migrate(dir, m, checkpoint)
      const encoded = await regular(Path.join(dir, 'frames.bin'), MAX_FRAMES)
      if (encoded.length !== m.frameBytes || digest(encoded) !== m.frameSha256 || !validFrames(decodeFrames(encoded))) throw new Error('corpus_invalid')
      if (m.version === 2 && (await fsp.readdir(dir)).includes('audio')) {
        const audio = await regular(Path.join(dir, 'audio'), MAX_AUDIO)
        if (audio.length !== m.audioBytes || digest(audio) !== m.sha256) throw new Error('corpus_invalid')
        await checkpoint(m.itemId, m.episodeId)
        await fsp.unlink(Path.join(dir, 'audio'))
        await syncDir(dir)
      }
      m.frames = decodeFrames(encoded)
      m.fingerprint = fingerprint
    }
    const current = await this.inventory(itemId, episodeId)
    return { ...current, versions: state.versions }
  }

  async migrate(dir, m, checkpoint) {
    const audioPath = Path.join(dir, 'audio')
    const audio = await regular(audioPath, MAX_AUDIO)
    const fp = await regular(Path.join(dir, 'fingerprint.json'), MAX_FP)
    if (audio.length !== m.audioBytes || digest(audio) !== m.sha256 || fp.length !== m.fingerprintBytes || digest(fp) !== m.fingerprintSha256) throw new Error('corpus_invalid')
    let frames
    if ((await fsp.readdir(dir)).includes('frames.bin')) {
      frames = await regular(Path.join(dir, 'frames.bin'), MAX_FRAMES)
      const canonical = encodeFrames(audio)
      if (!frames.equals(canonical) || !validFrames(decodeFrames(frames))) throw new Error('corpus_invalid')
    } else {
      await checkpoint(m.itemId, m.episodeId)
      frames = encodeFrames(audio)
      if (!Buffer.isBuffer(frames) || !frames.length || frames.length > MAX_FRAMES || !validFrames(decodeFrames(frames))) throw new Error('corpus_invalid')
      await writeSync(Path.join(dir, 'frames.bin'), frames)
      await syncDir(dir)
    }
    const manifest = { ...m, version: 2, format: 'mpeg-frames-v1', frameBytes: frames.length, frameSha256: digest(frames) }
    const tmp = Path.join(dir, 'manifest.next')
    if ((await fsp.readdir(dir)).includes('manifest.next')) await fsp.unlink(tmp)
    await writeSync(tmp, Buffer.from(JSON.stringify(manifest)))
    await syncDir(dir)
    await checkpoint(m.itemId, m.episodeId)
    await fsp.rename(tmp, Path.join(dir, 'manifest.json'))
    await syncDir(dir)
    const saved = await regular(Path.join(dir, 'frames.bin'), MAX_FRAMES)
    if (saved.length !== manifest.frameBytes || digest(saved) !== manifest.frameSha256 || !validFrames(decodeFrames(saved))) throw new Error('corpus_invalid')
    await checkpoint(m.itemId, m.episodeId)
    await fsp.unlink(audioPath)
    await syncDir(dir)
    Object.assign(m, manifest)
  }

  async retain(input, checkpoint = async () => {}) {
    const { itemId, episodeId, data, fingerprint, duration, provider, route } = input
    if (!validId(itemId) || !validId(episodeId) || !Buffer.isBuffer(data) || !data.length || data.length > MAX_AUDIO || !validFingerprint(fingerprint) || !Number.isFinite(duration) || duration < 50 || duration > 14400 || !['apple', 'gpodder'].includes(provider) || !['direct', 'vpn_proxy'].includes(route)) throw new Error('corpus_invalid_input')
    await checkpoint()
    await fsp.mkdir(this.root, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e })
    const state = await this.inventory(itemId, episodeId)
    await syncDir(Path.dirname(this.root))
    const fp = Buffer.from(JSON.stringify(fingerprint))
    if (fp.length > MAX_FP) throw new Error('corpus_invalid_input')
    const sha256 = digest(data)
    const fingerprintSha256 = digest(fp)
    const duplicate = state.versions.find((m) => m.sha256 === sha256 || m.fingerprintSha256 === fingerprintSha256)
    if (duplicate) return { status: 'duplicate', versionId: duplicate.versionId, sha256, fingerprintSha256 }
    if (state.count >= 5) return { status: 'paused', reason: 'episode_limit' }
    const frames = encodeFrames(data)
    if (!Buffer.isBuffer(frames) || !frames.length || frames.length > MAX_FRAMES || !validFrames(decodeFrames(frames))) throw new Error('corpus_invalid')
    const versionId = digest(JSON.stringify([itemId, episodeId, sha256, fingerprintSha256]))
    const manifest = { version: 2, versionId, itemId, episodeId, algorithm: ALGORITHM, sha256, fingerprintSha256, provider, route, collectedAt: new Date().toISOString(), duration, audioBytes: data.length, fingerprintBytes: fp.length, frameBytes: frames.length, frameSha256: digest(frames), format: 'mpeg-frames-v1' }
    const bytes = Buffer.from(JSON.stringify(manifest))
    if (state.totalBytes + frames.length + fp.length + bytes.length > this.limit) return { status: 'paused', reason: 'corpus_limit' }
    const stage = await fsp.mkdtemp(Path.join(this.root, '.stage-'))
    try {
      for (const [name, content] of [['frames.bin', frames], ['fingerprint.json', fp], ['manifest.json', bytes]]) await writeSync(Path.join(stage, name), content)
      await syncDir(stage)
      await checkpoint()
      await fsp.rename(stage, Path.join(this.root, versionId))
      await syncDir(this.root)
      return { status: 'retained', ...manifest }
    } finally { await fsp.rm(stage, { recursive: true, force: true }) }
  }
}
module.exports = { ComparisonCorpus, ALGORITHM, validId }
