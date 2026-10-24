const { expect } = require('chai')
const { align, matchesEpisode, normalize, PERIOD } = require('../vendor/daiAlignment')

describe('DAI candidate primitives', () => {
  it('matches title and publication day, not title alone', () => {
    expect(normalize('Show: A!')).to.equal('show a')
    expect(matchesEpisode({ title: 'A', publishedAt: '2026-01-01' }, { title: 'A', publishedAt: '2025-01-01' })).to.equal(false)
    expect(matchesEpisode({ title: 'A' }, { title: 'A' })).to.equal(false)
    expect(matchesEpisode({ title: 'A', publishedAt: '2026-01-01' }, { title: 'a', publishedAt: '2026-01-01T12:00:00Z' })).to.equal(true)
  })
  it('rejects identical or insufficient fingerprint candidates', () => {
    expect(align(Array(399).fill(1), Array(399).fill(2)).reason).to.equal('insufficient_audio')
    let seed = 42
    const a = Array.from({ length: 1500 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed })
    expect(align(a, a).reason).to.equal('insufficient_diversity')
    expect(PERIOD).to.be.greaterThan(0)
  })
})
