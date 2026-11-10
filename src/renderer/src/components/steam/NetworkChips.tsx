import { cn } from 'cn'
import type { NetworkChoice } from '../../hooks/useNetworkChoice'
import { useNetworkVisuals } from '../../hooks/useNetworkVisuals'
import { useAppStore } from '../../store/useAppStore'

/** Every network as a chip that picks it or leaves it out. */
export function NetworkChips({
  choice,
  labelledBy
}: {
  choice: NetworkChoice
  /** The id of what names the group. */
  labelledBy: string
}): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const networkVisual = useNetworkVisuals()
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="flex min-w-0 flex-1 flex-wrap gap-1.5"
    >
      {interfaces.map((iface) => {
        const visual = networkVisual(iface.id, iface.kind, iface.displayName)
        const selected = choice.networkIds.includes(iface.id)
        const reached = choice.isReached(iface.id)
        return (
          <button
            key={iface.id}
            type="button"
            aria-pressed={selected}
            aria-disabled={reached || undefined}
            title={reached ? 'Data limit reached' : undefined}
            onClick={() => choice.toggle(iface.id)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors',
              selected
                ? 'border-transparent'
                : 'border-border text-[var(--text-secondary)] opacity-70',
              reached && 'cursor-not-allowed line-through opacity-50'
            )}
            style={selected ? { background: visual.bg, borderColor: visual.border } : undefined}
          >
            <span className="size-2 rounded-full" style={{ background: visual.solid }} />
            {visual.name}
          </button>
        )
      })}
    </div>
  )
}
