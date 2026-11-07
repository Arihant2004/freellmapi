import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { useI18n } from '@/i18n'

interface UnifiedKeyData {
  apiKey: string
  /** Address for clients outside the LAN (PUBLIC_API_URL), when deployed with one. */
  publicUrl?: string | null
}

// One label / value / Copy row of the "For your websites" panel.
function CopyRow({ label, value, display }: { label: string; value: string; display?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  async function copy() {
    if (!await copyText(value)) {
      toast.error(t('common.copyFailed'))
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate rounded-md bg-background px-2 py-1 font-mono tabular-nums">{display ?? value}</code>
      <Button variant="outline" size="sm" onClick={() => void copy()}>
        {copied ? t('common.copied') : t('common.copy')}
      </Button>
    </>
  )
}

export function UnifiedKeySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data, isError } = useQuery<UnifiedKeyData>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch<{ apiKey: string }>('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: (res) => {
      // Write the fresh key into the cache BEFORE unmasking: invalidating
      // alone would leave the old, now-revoked key in the cache until the
      // refetch lands, and it would flash unmasked in the meantime.
      queryClient.setQueryData<UnifiedKeyData>(['unified-key'], prev => ({ ...prev, apiKey: res.apiKey }))
      // Reveal the fresh key right away: the whole point of regenerating is
      // to move apps to the new value, and a masked box hides exactly the
      // string they need to copy next. Showing it doubles as the success
      // feedback, so no toast (and no new key in 60 locale files) is needed.
      setShowKey(true)
    },
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  async function copy() {
    if (!await copyText(apiKey)) {
      toast.error(t('common.copyFailed'))
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.unifiedKey')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.unifiedKeyDescBefore')}<code className="font-mono">api_key</code>{t('keys.unifiedKeyDescAfter')}
          </p>
        </div>
        {/* Regenerating revokes the key every running app authenticates with,
            so it goes through the dashboard's two-step destructive idiom
            (ConfirmButton) instead of firing on a single click. */}
        <ConfirmButton
          variant="ghost"
          size="sm"
          // Armed label stays the shared "Confirm" — the same destructive
          // idiom every other ConfirmButton on the dashboard uses.
          disabled={regenerate.isPending || isError}
          onConfirm={() => regenerate.mutate()}
        >
          {t('keys.regenerate')}
        </ConfirmButton>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('keys.serverUnreachableBefore')}<code className="font-mono">{baseUrl.replace('/v1', '')}</code>{t('keys.serverUnreachableAfter')}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('keys.hideKey') : t('keys.showKey')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? t('keys.copiedKey') : t('keys.copyKey')}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">{t('keys.baseUrl')}</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">{t('keys.endpointChat')}</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">{t('keys.endpointResponses')}</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">{t('keys.endpointMessages')}</span>
        <code className="font-mono">/v1/messages <span className="text-muted-foreground">({t('keys.endpointMessagesHint')})</span></code>
        <span className="text-muted-foreground">{t('keys.endpointEmbeddings')}</span>
        <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">({t('keys.endpointEmbeddingsHint')})</span></code>
      </div>

      {data?.publicUrl && (
        <div className="mt-4 rounded-xl border bg-muted/40 p-3">
          <h3 className="text-xs font-medium">{t('keys.publicTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('keys.publicDesc')}</p>
          <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-xs">
            <CopyRow label={t('keys.baseUrl')} value={data.publicUrl} />
            <CopyRow label={t('agents.apiKey')} value={apiKey} display={showKey ? apiKey : masked} />
            <CopyRow label={t('common.model')} value="auto" />
          </div>
        </div>
      )}

      <details className="group mt-4 rounded-xl border bg-muted/40 p-3">
        <summary className="cursor-pointer select-none text-xs font-medium">{t('keys.quickStart')}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('keys.quickStartDesc')}</p>
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t('keys.exampleAuto')}</div>
            <pre className="overflow-x-auto rounded-lg bg-background p-3 font-mono text-[11px] leading-relaxed"><code>{`curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer $YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'`}</code></pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t('keys.exampleFast')}</div>
            <pre className="overflow-x-auto rounded-lg bg-background p-3 font-mono text-[11px] leading-relaxed"><code>{`curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer $YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto:fast","messages":[{"role":"user","content":"Hello"}]}'`}</code></pre>
          </div>
        </div>
      </details>
    </section>
  )
}
