import { isIP } from 'node:net'

// 402index's production-directory policy, not an x402 protocol restriction.
const EXCLUDED_HOSTS = ['trycloudflare.com', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
  'ts.net', 'lhr.life', 'srv.us', 'sslip.io', 'nip.io', 'localhost', 'localhost.localdomain']
const TESTNETS = new Set(['eip155:84532', 'base-sepolia', 'solana-devnet', 'solana-testnet',
  'eip155:97', 'bsc-testnet', 'eip155:43113', 'avalanche-fuji', 'eip155:713715', 'sei-testnet',
  'eip155:80002', 'polygon-amoy', 'eip155:1952', 'xlayer-testnet',
  'eip155:324705682', 'skale-base-sepolia', 'eip155:421614', 'arbitrum-sepolia',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'.toLowerCase()])

export function eligiblePayaiItem(item) {
  const raw = item?.resource || item?.accepts?.[0]?.resource
  if (!item || typeof raw !== 'string' || !Array.isArray(item.accepts)) {
    throw new Error('invalid discovery item')
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  let url
  try { url = new URL(raw) } catch { return null }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const ip = host.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isIP(ip) || !host.includes('.')) return null
  if (EXCLUDED_HOSTS.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) return null
  const accepts = item.accepts.filter(accept => typeof accept?.network === 'string' && !TESTNETS.has(accept.network.toLowerCase()))
  if (accepts.length === 0) return null
  url.hostname = host
  return { ...item, resource: url.href, accepts }
}
