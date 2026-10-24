const http = require('http')
const https = require('https')
const tls = require('tls')
const net = require('net')
const dns = require('dns')
const ipaddr = require('ipaddr.js')

function configuration() {
  if (process.env.AD_ANALYSIS_PROXY_URL === undefined) return null
  try {
    const url = new URL(process.env.AD_ANALYSIS_PROXY_URL)
    if (url.protocol !== 'http:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.href.includes('?') || url.href.includes('#')) throw new Error()
    return url
  } catch { throw new Error('invalid_analysis_proxy') }
}

function publicAddress(address) {
  if (!net.isIP(address)) return false
  const ip = ipaddr.parse(address)
  if (ip.range() !== 'unicast') return false
  // IANA special-purpose registries supplement ipaddr.js, including newer
  // documentation ranges. Conservatively exclude special-purpose anycast too.
  const special = ip.kind() === 'ipv6'
    ? ['2001::/23', '2620:4f:8000::/48', '3fff::/20']
    : ['192.31.196.0/24', '192.52.193.0/24', '192.175.48.0/24', '198.18.0.0/15']
  if (ip.kind() === 'ipv6' && !ip.match(ipaddr.parse('2000::'), 3)) return false
  return !special.some((range) => ip.match(ipaddr.parseCIDR(range)))
}

async function agents(url, proxy, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const records = net.isIP(hostname) ? [{ address: hostname }] : await new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('request_timeout'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    dns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      signal.removeEventListener('abort', cancel)
      if (error) reject(new Error('proxy_failed_or_blocked'))
      else resolve(records)
    })
  })
  if (!records.length || records.some(({ address }) => !publicAddress(address))) throw new Error('unsafe_url')
  if (signal.aborted) throw new Error('request_timeout')
  const address = records[0].address
  const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`
  const agent = url.protocol === 'https:' ? new https.Agent() : new http.Agent()
  agent.createConnection = (options, callback) => {
    let socket
    let completed = false
    const finish = (error, connection) => {
      if (completed) return
      completed = true
      callback(error, connection)
    }
    const connect = http.request(proxy, { method: 'CONNECT', path: authority, agent: false, signal, headers: { Host: authority } })
    const cancel = () => socket?.destroy(new Error('request_timeout'))
    signal.addEventListener('abort', cancel, { once: true })
    connect.once('error', (error) => { signal.removeEventListener('abort', cancel); finish(error) })
    connect.once('connect', (response, tunnel, head) => {
      socket = tunnel
      socket.once('close', () => signal.removeEventListener('abort', cancel))
      socket.once('error', (error) => finish(error))
      if (signal.aborted || response.statusCode !== 200 || head.length) {
        socket.destroy()
        finish(new Error('proxy_failed_or_blocked'))
        return
      }
      if (url.protocol === 'https:') {
        socket = tls.connect({ socket: tunnel, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true, checkServerIdentity: (_, cert) => tls.checkServerIdentity(hostname, cert) })
        socket.once('error', (error) => finish(error))
        socket.once('secureConnect', () => finish(null, socket))
      } else finish(null, socket)
    })
    connect.end()
  }
  return { httpAgent: agent, httpsAgent: agent }
}

module.exports = { configuration, agents }
