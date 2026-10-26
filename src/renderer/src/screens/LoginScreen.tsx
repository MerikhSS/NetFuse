import type { SteamLoginState } from '@shared/steam'
import { Logo } from '../components/Logo'
import { SteamLogin } from '../components/steam/SteamLogin'

// What the window shows until Steam is logged in: everything else is the account's own games, so
// there is nothing to show before. A remembered login skips it (see steamLoginState), unless
// Steam turns that login down.

export function LoginScreen({ state }: { state: SteamLoginState }): React.JSX.Element {
  return (
    <div className="flex h-full overflow-y-auto bg-background">
      <div className="m-auto flex w-full max-w-[460px] flex-col gap-6 px-6 py-10">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo className="size-20 drop-shadow-sm" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[22px] leading-tight font-bold">Log in to Steam</h1>
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Your library, downloaded over every network you have at once.
            </p>
          </div>
        </div>
        <section
          aria-label="Steam login"
          className="flex flex-col gap-3.5 rounded-xl border-[0.5px] border-border bg-card p-5 shadow-sm"
        >
          <SteamLogin state={state} />
        </section>
      </div>
    </div>
  )
}
