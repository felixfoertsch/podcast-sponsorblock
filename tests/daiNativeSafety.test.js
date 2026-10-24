const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { align, PERIOD, DELAY } = require('../vendor/daiAlignment')

describe('DAI native fingerprint safety', () => {
  it('rejects malformed and inadequate fingerprints without candidate spans', () => {
    expect(align([], []).segments).to.deep.equal([])
    expect(align(Array(120001).fill(1), Array(120001).fill(2)).segments).to.deep.equal([])
    expect(PERIOD).to.be.greaterThan(0)
    expect(DELAY).to.be.greaterThan(0)
  })
  it('runs native fingerprint smoke when binaries available', function () {
    const fpcalc = process.env.FPCALC_PATH || '/opt/homebrew/bin/fpcalc'
    const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg'
    if (!fs.existsSync(fpcalc) || !fs.existsSync(ffmpeg)) this.skip()
    expect(execFileSync(fpcalc, ['-version'], { encoding: 'utf8' })).to.match(/fpcalc version 1\.(5|6)\./)
    expect(execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' })).to.match(/ffmpeg version/)
  })
})
