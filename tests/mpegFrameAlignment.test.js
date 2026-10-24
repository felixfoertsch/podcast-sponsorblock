const { expect } = require('chai')
const { frames, align, encodeFrames, decodeFrames } = require('../vendor/mpegFrameAlignment')

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of 1152 samples.
const FRAME = 1152 / 44100
const mp3 = (ids) => Buffer.concat(ids.map((id) => {
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x64])
  frame.writeUInt32BE(id, 4)
  return frame
}))
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i)

describe('MPEG frame alignment', () => {
  it('reproduces full-audio comparisons from compact evidence, including changed originals', () => {
    const show = range(0, 3000)
    const catalog = mp3(show)
    const compact = decodeFrames(encodeFrames(catalog))
    for (const ids of [show, [...range(100000, 100766), ...show], [...show.slice(0, 1148), ...range(100000, 100766), ...show.slice(1148)]]) {
      const original = frames(mp3(ids))
      expect(align(original, compact)).to.deep.equal(align(original, frames(catalog)))
    }
    expect(Buffer.from(compact.hashes.buffer)).to.deep.equal(Buffer.from(frames(catalog).hashes.buffer))
    expect(Buffer.from(compact.times.buffer)).to.deep.equal(Buffer.from(frames(catalog).times.buffer))
  })
  it('passes compact typed arrays through the actual alignment worker', async () => {
    const fs = require('fs')
    const path = require('path')
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mpeg-worker-'))
    const audio = mp3([...range(100000, 100766), ...range(0, 3000)])
    const catalog = mp3(range(0, 3000))
    const file = path.join(dir, 'audio')
    fs.writeFileSync(file, audio)
    try {
      const { Worker } = require('worker_threads')
      const worker = new Worker(require('path').join(__dirname, '../vendor/daiAlignmentWorker.js'), { workerData: { original: file, variant: decodeFrames(encodeFrames(catalog)) } })
      const result = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
      expect(result).to.deep.equal(align(frames(audio), frames(catalog)))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects malformed compact evidence', () => {
    for (const value of [Buffer.alloc(0), Buffer.alloc(12), Buffer.alloc(25), Buffer.alloc(24 * 1024 * 1024 + 1)]) expect(() => decodeFrames(value)).to.throw('invalid_mpeg_evidence')
    const hostileHeader = encodeFrames(mp3(range(0, 10)))
    hostileHeader[0] |= 0x80
    expect(() => decodeFrames(hostileHeader)).to.throw('invalid_mpeg_evidence')
    const valid = encodeFrames(mp3(range(0, 10)))
    valid.writeDoubleLE(NaN, 10)
    expect(() => decodeFrames(valid)).to.throw('invalid_mpeg_evidence')
  })
  it('finds a stitched ad exact to one frame and nothing in the clean copy', () => {
    const show = range(0, 3000)
    const ad = range(100000, 100766)
    const clean = frames(mp3(show))
    const ads = frames(mp3([...show.slice(0, 1148), ...ad, ...show.slice(1148)]))
    expect(clean.hashes.length).to.equal(3000)
    expect(align(clean, ads)).to.include({ reason: 'no_inserted_audio' })
    const [segment, ...rest] = align(ads, clean).segments
    expect(rest).to.deep.equal([])
    expect(segment.start).to.be.closeTo(1148 * FRAME, 1e-6)
    expect(segment.end).to.be.closeTo((1148 + 766) * FRAME, 1e-6)
  })
  it('skips ID3 tags and rejects copies without shared frames', () => {
    const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5])
    expect(frames(Buffer.concat([tag, mp3(range(0, 10))])).hashes.length).to.equal(10)
    expect(align(frames(mp3(range(0, 2000))), frames(mp3(range(5000, 7000)))).reason).to.equal('insufficient_shared_audio')
    expect(align(frames(Buffer.from('not audio')), frames(mp3(range(0, 2000)))).reason).to.equal('not_mpeg')
  })
})
