// Chromaprint 1.5.x/1.6.x, algorithm TEST2: source fingerprinter_configuration.{h,cpp}.
// Each hash covers a window, not a point. Never tag that window's shared speech.
const PERIOD = 1365 / 11025
const DELAY = (19 * 1365 + 2731) / 11025
const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function matchesEpisode(original, candidate) {
  if (!normalize(original.title) || normalize(original.title) !== normalize(candidate.title)) return false
  const a = Number(new Date(original.publishedAt))
  const b = Number(new Date(candidate.publishedAt))
  // GUID alone is not trusted across unrelated feeds.
  return Number.isFinite(a) && a > 0 && Number.isFinite(b) && Math.abs(a - b) <= 86400000
}

function align(original, variant) {
  const empty = (reason) => ({ reason, segments: [], matchedSeconds: 0 })
  if (!Array.isArray(original) || !Array.isArray(variant) || original.length < 400 || variant.length < 400) return empty('insufficient_audio')
  if (original.length > 120000 || variant.length > 120000 || ![original, variant].every((values) => values.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff))) return empty('invalid_fingerprint')
  if (original.length === variant.length && original.every((v, i) => v === variant[i])) return empty('insufficient_diversity')
  // Banded lookup proposes anchors; full multi-hash Hamming check proves them.
  // Ambiguous/repetitive buckets are discarded rather than scanned quadratically.
  const width = 8
  const bits = (value) => {
    value = value - ((value >>> 1) & 0x55555555)
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333)
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  const index = new Map()
  for (let j = 0; j <= variant.length - width; j++) {
    for (let band = 0; band < 4; band++) {
      const key = `${band}:${(variant[j] >>> (band * 8)) & 255}:${(variant[j + 3] >>> (band * 8)) & 255}`
      const bucket = index.get(key) || []
      if (bucket.length < 2000) bucket.push(j)
      index.set(key, bucket)
    }
  }
  const anchors = []
  let comparisons = 0
  const stride = Math.max(4, Math.ceil(original.length / 4000))
  for (let i = 0; i <= original.length - width; i += stride) {
    const candidates = new Set()
    for (let band = 0; band < 4; band++) {
      const bucket = index.get(`${band}:${(original[i] >>> (band * 8)) & 255}:${(original[i + 3] >>> (band * 8)) & 255}`) || []
      if (bucket.length < 2000) bucket.forEach((j) => candidates.add(j))
    }
    let best = width * 3
    let matches = []
    for (const j of candidates) {
      if (++comparisons > 5000000) return empty('alignment_limit')
      let distance = 0
      for (let k = 0; k < width; k++) distance += bits(original[i + k] ^ variant[j + k])
      if (distance < best) { best = distance; matches = [j] }
      else if (distance === best) matches.push(j)
    }
    // Neighboring frame positions are one anchor, not competing episodes.
    if (matches.length && Math.max(...matches) - Math.min(...matches) <= 2) anchors.push([i, matches.sort((a, b) => a - b)[Math.floor(matches.length / 2)]])
  }
  anchors.sort((a, b) => a[0] - b[0])
  if (anchors.length < 80) return empty('no_shared_audio')
  const votes = new Map()
  for (const [a, b] of anchors) for (let offset = b - a - 2; offset <= b - a + 2; offset++) votes.set(offset, (votes.get(offset) || 0) + 1)
  const minimumVotes = Math.max(15, Math.max(...votes.values()) * 0.25)
  const offsets = [...votes].filter(([, count]) => count >= minimumVotes).sort((a, b) => b[1] - a[1]).reduce((all, [offset]) => {
    if (all.every((other) => Math.abs(other - offset) > 4)) all.push(offset)
    return all
  }, []).slice(0, 8)
  const runs = []
  for (const offset of offsets) {
    let last
    for (const [a, b] of anchors.filter(([a, b]) => Math.abs(b - a - offset) <= 2)) {
      if (last && a - last.end <= 40) last.end = a
      else { last = { start: a, end: a, offset }; runs.push(last) }
    }
  }
  const strong = runs.filter((r) => (r.end - r.start) * PERIOD >= 8).sort((a, b) => a.start - b.start)
  for (let i = 1; i < strong.length; i++) {
    if (strong[i].start + strong[i].offset <= strong[i - 1].end + strong[i - 1].offset) return empty('non_monotonic')
  }
  const matchedSeconds = strong.reduce((sum, r) => sum + (r.end - r.start) * PERIOD, 0)
  if (strong.length < 1 || matchedSeconds < Math.min(original.length, variant.length) * PERIOD * 0.65) return empty('insufficient_shared_audio')
  const unanchored = strong[0].start * PERIOD > 15 || (original.length - strong[strong.length - 1].end) * PERIOD > 15
  // At a splice, one hash window plus one anchor stride per edge and ±2 offset
  // tolerance per run can be unmatched without any catalog-only material.
  const spliceUncertainty = (width + 2 * stride + 4) * PERIOD + DELAY
  const segments = []
  for (let i = 1; i < strong.length; i++) {
    const before = strong[i - 1]
    const after = strong[i]
    const removed = (before.offset - after.offset) * PERIOD
    const gap = (after.start - before.end) * PERIOD
    const variantGap = gap - removed
    if (gap < 12 || gap > 200 || variantGap < -1 || variantGap > 200) continue
    // Unanchored ends cannot support the existing replacement interpretation.
    if (unanchored && (removed <= spliceUncertainty || variantGap > spliceUncertainty)) continue
    const start = (before.end + width) * PERIOD + DELAY + 1
    // ponytail: synthetic calibration only; retain 5 s inward margin until speech calibration.
    const end = after.start * PERIOD - DELAY - 5
    if (end - start >= 3) segments.push({ start, end, origin: 'dai', status: 'candidate' })
  }
  return { reason: segments.length ? 'candidate_insertions' : 'no_safe_candidates', segments, matchedSeconds }
}

module.exports = { PERIOD, DELAY, normalize, matchesEpisode, align }
