import type { Account } from '../../shared/types'

/** Use one owning account; never fetch Qwen's reduced anonymous catalogue. */
export function modelCatalogueAuthHeaders(
  providerId: string,
  accounts: Pick<Account, 'status' | 'credentials'>[],
): Record<string, string> {
  if (providerId !== 'qwen-ai') return {}
  const account = accounts.find(item => item.status === 'active'
    && typeof item.credentials?.token === 'string'
    && item.credentials.token.trim()
    && !item.credentials.token.trim().startsWith('c2a:'))
  if (!account) throw new Error('Qwen model catalogue requires a readable active account token')
  // Bearer authentication is accepted by the catalogue for both legacy and
  // access JWTs. Do not let a stale token cookie shadow this owning credential.
  return { Authorization: `Bearer ${account.credentials.token.trim()}` }
}
