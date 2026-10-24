const { expect } = require('chai')
const proxy = require('../vendor/adAnalysisProxy')

describe('Analysis proxy configuration', () => {
  const previous = process.env.AD_ANALYSIS_PROXY_URL
  afterEach(() => {
    if (previous === undefined) delete process.env.AD_ANALYSIS_PROXY_URL
    else process.env.AD_ANALYSIS_PROXY_URL = previous
  })
  it('leaves direct transport explicit when proxy is unset', () => {
    delete process.env.AD_ANALYSIS_PROXY_URL
    expect(proxy.configuration()).to.equal(null)
  })
  it('rejects malformed and credential-bearing proxy configuration', () => {
    for (const value of ['', 'https://proxy:8888', 'http://user:secret@proxy:8888', 'http://proxy/path', 'http://proxy/?query', 'not a URL']) {
      process.env.AD_ANALYSIS_PROXY_URL = value
      expect(() => proxy.configuration()).to.throw('invalid_analysis_proxy')
    }
  })
})
