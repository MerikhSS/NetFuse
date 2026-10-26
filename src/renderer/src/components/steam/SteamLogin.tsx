import type { SteamLoginState } from '@shared/steam'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { describeError } from '../../utils/format'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

// Logging in to Steam, the two ways Steam offers: an account name and password (then a Steam
// Guard code or an approval in the mobile app, if the account asks for one), or a QR code
// scanned with the Steam Mobile App. What is typed goes straight to the main process and is
// cleared here at once; all that comes back is the login's state.

const labelClass = 'w-28 shrink-0 text-[12.5px] text-[var(--text-secondary)]'

export function SteamLogin({ state }: { state: SteamLoginState | null }): React.JSX.Element {
  const [method, setMethod] = useState<'credentials' | 'qr'>('credentials')
  const [accountName, setAccountName] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canRemember = state?.status === 'logged-out' && state.canRemember

  const run = (work: Promise<void>): void => {
    setError(null)
    work.catch((cause: unknown) => setError(describeError(cause)))
  }
  const cancel = (): void => run(window.netfuse.steamCancelLogin())

  if (!state || state.status === 'connecting') {
    return (
      <Waiting message="Connecting to Steam…" onCancel={state ? cancel : undefined} error={error} />
    )
  }

  if (state.status === 'awaiting-code') {
    const where =
      state.via === 'email'
        ? `Steam sent a code to your email${state.emailDomain ? ` at …@${state.emailDomain}` : ''}.`
        : 'Enter the code the Steam Mobile App shows.'
    return (
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault()
          const typed = code.trim()
          setCode('')
          if (typed) run(window.netfuse.steamSubmitCode(typed))
        }}
      >
        <div className="text-[13px]">{where}</div>
        <div className="flex items-center gap-3">
          <label htmlFor="steam-guard-code" className={labelClass}>
            Steam Guard code
          </label>
          <Input
            id="steam-guard-code"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={8}
            className="w-32 font-mono tracking-[0.2em]"
          />
          <Button type="submit" disabled={!code.trim()}>
            Continue
          </Button>
        </div>
        {state.canConfirm && (
          <div className="text-[12.5px] text-muted-foreground">
            Or approve this login in the Steam Mobile App.
          </div>
        )}
        <Problem message={error ?? state.error} />
        <div>
          <Button type="button" variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  if (state.status === 'awaiting-confirmation') {
    return (
      <Waiting
        message={
          state.via === 'device'
            ? 'Approve this login in the Steam Mobile App.'
            : 'Approve this login from the email Steam sent you.'
        }
        onCancel={cancel}
        error={error}
      />
    )
  }

  if (state.status === 'awaiting-qr') {
    return (
      <div className="flex flex-col items-center gap-3">
        <QrCode modules={state.qr} />
        <div className="text-center text-[13px]">
          {state.scanned
            ? 'Scanned. Approve the login on your phone.'
            : 'Scan this with the Steam Mobile App: tap the shield, then scan a QR code.'}
        </div>
        <Problem message={error} />
        <Button type="button" variant="secondary" onClick={cancel}>
          Cancel
        </Button>
      </div>
    )
  }

  // Logged out (a logged-in state never reaches here).
  const startQr = (): void => run(window.netfuse.steamLogin({ method: 'qr', remember }))
  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (method === 'qr') return startQr()
        const typed = password
        // Not kept here a moment longer than it takes to hand it over.
        setPassword('')
        run(
          window.netfuse.steamLogin({
            method: 'credentials',
            accountName: accountName.trim(),
            password: typed,
            remember
          })
        )
      }}
    >
      <div className="text-[13px] text-[var(--text-secondary)]">
        Log in to download the games this Steam account owns. NetFuse keeps no password: Steam hands
        it a login token instead.
      </div>
      <ToggleGroup
        value={[method]}
        onValueChange={(values) => {
          if (values.length > 0) setMethod(values[0] as 'credentials' | 'qr')
        }}
        aria-label="How to log in"
        variant="pill"
        size="xs"
        spacing={1}
        className="self-start"
      >
        <ToggleGroupItem value="credentials" className="h-6 px-2.5">
          Account name
        </ToggleGroupItem>
        <ToggleGroupItem value="qr" className="h-6 px-2.5">
          QR code
        </ToggleGroupItem>
      </ToggleGroup>

      {method === 'credentials' ? (
        <>
          <div className="flex items-center gap-3">
            <label htmlFor="steam-account" className={labelClass}>
              Account name
            </label>
            <Input
              id="steam-account"
              autoFocus
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              autoComplete="username"
              spellCheck={false}
              className="max-w-72"
            />
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="steam-password" className={labelClass}>
              Password
            </label>
            <Input
              id="steam-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="max-w-72"
            />
          </div>
        </>
      ) : (
        <div className="text-[12.5px] text-muted-foreground">
          A QR code to scan with the Steam Mobile App comes up next.
        </div>
      )}

      <label className="flex items-start gap-2 text-[12.5px]">
        <Checkbox
          checked={remember && canRemember}
          disabled={!canRemember}
          onCheckedChange={(checked) => setRemember(checked)}
          className="mt-0.5"
        />
        <span>
          Stay logged in on this computer
          {!canRemember && (
            <span className="block text-muted-foreground">
              This computer has no system keychain for NetFuse to keep the login in, so you’ll log
              in each time NetFuse starts.
            </span>
          )}
        </span>
      </label>

      <Problem message={error ?? (state.status === 'logged-out' ? state.error : undefined)} />
      <div>
        <Button
          type="submit"
          disabled={method === 'credentials' && (!accountName.trim() || !password)}
        >
          {method === 'qr' ? 'Show QR code' : 'Log in'}
        </Button>
      </div>
    </form>
  )
}

function Waiting({
  message,
  onCancel,
  error
}: {
  message: string
  onCancel?: () => void
  error: string | null
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-3">
      <div className="text-[13px]">{message}</div>
      <Problem message={error} />
      {onCancel && (
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  )
}

function Problem({ message }: { message?: string | null }): React.JSX.Element | null {
  if (!message) return null
  return (
    <div role="alert" className="flex items-start gap-2 text-[12.5px] text-[var(--color-danger)]">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      {describeError(message)}
    </div>
  )
}

/** The login's QR code, dark on light whatever the theme, so that any phone can read it. */
function QrCode({ modules }: { modules: boolean[][] }): React.JSX.Element {
  const quiet = 4
  const size = modules.length + quiet * 2
  let path = ''
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    })
  )
  return (
    <svg
      role="img"
      aria-label="Steam login QR code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-52 rounded-lg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
